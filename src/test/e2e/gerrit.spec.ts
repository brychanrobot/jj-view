/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { convertJjChangeIdToHex } from '../../utils/jj-utils';
import { FakeGerritServer } from '../helpers/fake-gerrit-server';
import { buildGraph, type CommitDefinition, TestRepo } from '../test-repo';
import { focusJJLog, launchVSCode, waitForLogCommitRow } from './e2e-helpers';

test.describe('Gerrit Integration E2E', () => {
    let gerrit: FakeGerritServer;

    test.beforeAll(async () => {
        gerrit = new FakeGerritServer();
        await gerrit.start();
    });

    test.afterAll(async () => {
        await gerrit.stop();
    });

    test('Detects Gerrit status via various methods (Change-Id, Link, Mixed, and Fallback)', async () => {
        const repo = new TestRepo();
        repo.init();

        const graph: CommitDefinition[] = [
            { label: 'base', description: 'base' },
            { label: 'explicit-change-id', parents: ['base'], description: 'Explicit Change-Id' },
            { label: 'fallback-only', parents: ['base'], description: 'Fallback Only' },
            { label: 'link-only', parents: ['base'], description: 'Link Only' },
            { label: 'mixed-trailers', parents: ['fallback-only'], description: 'Mixed trailers' },
        ];

        const commits = await buildGraph(repo, graph);
        const clNumbers: Record<string, number> = {};

        // 1. Explicit Change-Id (Must be 40 hex digits)
        const id1 = `I${'1'.repeat(40)}`;
        repo.describe(`Explicit Change-Id\n\nChange-Id: ${id1}`, commits['explicit-change-id'].changeId);
        clNumbers['explicit-change-id'] = gerrit.registerChange(id1);

        // 2. Fallback Only (No trailer)
        const idFallback = `I${convertJjChangeIdToHex(commits['fallback-only'].changeId)}`;
        clNumbers['fallback-only'] = gerrit.registerChange(idFallback, 'mismatched-parent');

        // 3. Link Only
        const numLink = 1234;
        repo.describe(`Link Only\n\nLink: http://localhost/c/project/+/${numLink}`, commits['link-only'].changeId);
        gerrit.registerChangeByNumber(numLink);
        clNumbers['link-only'] = numLink;

        // 4. Mixed (Both trailers)
        const idMixed = `I${'2'.repeat(40)}`;
        const numMixed = 5678;
        repo.describe(
            `Mixed trailers\n\nChange-Id: ${idMixed}\nLink: http://localhost/${numMixed}`,
            commits['mixed-trailers'].changeId,
        );
        gerrit.registerChangeByNumber(numMixed, idMixed);
        clNumbers['mixed-trailers'] = numMixed;

        const { app, page, userDataDir } = await launchVSCode(repo, {
            'jj-view.gerrit.host': gerrit.url,
            'jj-view.uploadCommand': 'describe -m uploaded_successfully',
        });

        try {
            await focusJJLog(page);

            // Verify rows show Gerrit status

            // Explicit Change-Id
            const row1 = await waitForLogCommitRow(page, 'Explicit Change-Id');
            await expect(row1.locator('a', { hasText: `CL/${clNumbers['explicit-change-id']}` })).toBeVisible({
                timeout: 20000,
            });

            // Fallback (has parent mismatch)
            const rowFallback = await waitForLogCommitRow(page, 'Fallback Only');
            await expect(rowFallback.locator('a', { hasText: `CL/${clNumbers['fallback-only']}` })).toBeVisible({
                timeout: 20000,
            });

            const uploadButton = rowFallback.getByRole('button', { name: 'Upload changes to Gerrit' });
            await expect(uploadButton).toBeVisible();

            // Link Only
            const rowLink = await waitForLogCommitRow(page, 'Link Only');
            await expect(rowLink.locator('a', { hasText: `CL/${clNumbers['link-only']}` })).toBeVisible({
                timeout: 20000,
            });

            // Mixed
            const rowMixed = await waitForLogCommitRow(page, 'Mixed trailers');
            await expect(rowMixed.locator('a', { hasText: `CL/${clNumbers['mixed-trailers']}` })).toBeVisible({
                timeout: 20000,
            });

            // Test upload command
            await uploadButton.click();
            const fallbackId = commits['fallback-only'].changeId;
            await expect(async () => {
                const desc = repo.getDescription(fallbackId);
                expect(desc).toContain('uploaded_successfully');
            }).toPass({ timeout: 15000 });
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test("Detects 'Needs Upload' after rebase (rebase hole)", async () => {
        const repo = new TestRepo();
        repo.init();

        const graph: CommitDefinition[] = [
            { label: 'base', description: 'base' },
            { label: 'parent', parents: ['base'], description: 'Parent' },
            { label: 'child', parents: ['parent'], description: 'Child' },
        ];

        const commits = await buildGraph(repo, graph);

        // Register both in Gerrit
        const parentId = `I${convertJjChangeIdToHex(commits.parent.changeId)}`;
        const childId = `I${convertJjChangeIdToHex(commits.child.changeId)}`;

        // Gerrit state matches initial local state
        gerrit.registerChange(parentId, 'base-sha');
        gerrit.registerChange(childId, 'sha-1000'); // sha-1000 is what parent gets in mock Gerrit

        // Rebase child to base locally (skipping parent)
        repo.rebase({ source: commits.child.changeId, destination: commits.base.changeId });

        const { app, page, userDataDir } = await launchVSCode(repo, {
            'jj-view.gerrit.host': gerrit.url,
        });

        try {
            await focusJJLog(page);

            // Row for Child should show upload button because parent mismatch
            // (locally points to base, Gerrit expects 'sha-1000' which is the old parent)
            const rowChild = await waitForLogCommitRow(page, 'Child');
            const uploadButton = rowChild.getByRole('button', { name: 'Upload changes to Gerrit' });
            await expect(uploadButton).toBeVisible({ timeout: 20000 });
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });
});
