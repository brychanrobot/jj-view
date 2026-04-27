/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { buildGraph, type CommitId, TestRepo } from '../test-repo';
import { expectModifiedFiles, focusJJLog, launchVSCode, openFileInEditor, waitForQuickInput } from './e2e-helpers';

test.describe('Arbitrary Diff E2E', () => {
    let repo: TestRepo;
    let app: ElectronApplication;
    let page: Page;
    let userDataDir: string;
    let nodes: Record<string, CommitId>;

    test.beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        repo.writeFile('f.txt', 'base content\n');
        repo.describe('initial');

        nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'base content\n' } },
            { label: 'branchA1', parents: ['initial'], description: 'branchA1', files: { 'f.txt': 'A1 content\n' } },
            { label: 'branchA2', parents: ['branchA1'], description: 'branchA2', files: { 'f.txt': 'A2 content\n' } },
            { label: 'branchB1', parents: ['initial'], description: 'branchB1', files: { 'g.txt': 'B1 content\n' } },
            {
                label: 'mergeAB',
                parents: ['branchA2', 'branchB1'],
                description: 'mergeAB',
                files: { 'f.txt': 'mergeAB content\n' },
            },
            { label: 'branchC1', parents: ['branchA1'], description: 'branchC1', files: { 'f.txt': 'C1 content\n' } },
            { label: 'commit1', parents: ['mergeAB'], description: 'commit1', files: { 'f.txt': 'commit1 content\n' } },
            {
                label: 'commit2',
                parents: ['commit1'],
                description: 'commit2',
                files: { 'f.txt': 'commit2 content\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const setup = await launchVSCode(repo);
        app = setup.app;
        page = setup.page;
        userDataDir = setup.userDataDir;

        await focusJJLog(page);
    });

    test.afterEach(async () => {
        if (app) {
            await app.close();
        }
        if (userDataDir) {
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
        }
        if (repo) {
            repo.dispose();
        }
    });

    test('Compare All Files with Revision... (Ancestor)', async () => {
        // Launch using keyboard shortcut with retry
        let input!: Locator;
        await expect(async () => {
            await page.keyboard.press('Control+Alt+c');
            input = await waitForQuickInput(page, 2000);
        }).toPass({ timeout: 15000 });
        await input.focus();

        // Type prefix of commit1
        const commit1Id = nodes.commit1.changeId;
        const prefix = commit1Id.substring(0, 4);
        await input.fill(prefix);
        await page.keyboard.press('Enter');

        // Verification: A diff editor tab should open.
        await expect(page.getByRole('tab', { name: new RegExp(`^Compare ${prefix}`) })).toBeVisible({
            timeout: 10000,
        });

        await expectModifiedFiles(page, ['f.txt']);
    });

    test('Compare All Files with Revision... (Arbitrary)', async () => {
        // Launch using keyboard shortcut with retry
        let input!: Locator;
        await expect(async () => {
            await page.keyboard.press('Control+Alt+c');
            input = await waitForQuickInput(page, 2000);
        }).toPass({ timeout: 15000 });
        await input.focus();

        // Type prefix of branchC1 (which is NOT an ancestor)
        const branchC1Id = nodes.branchC1.changeId;
        const prefix = branchC1Id.substring(0, 4);
        await input.fill(prefix);
        await page.keyboard.press('Enter');

        // Verification: A diff editor tab should open.
        await expect(page.getByRole('tab', { name: new RegExp(`^Compare ${prefix}`) })).toBeVisible({
            timeout: 10000,
        });

        await expectModifiedFiles(page, ['f.txt', 'g.txt']);
    });

    test('Compare File with Revision... (Ancestor)', async () => {
        await openFileInEditor(page, 'f.txt');

        // Launch using keyboard shortcut with retry
        let input!: Locator;
        await expect(async () => {
            await page.keyboard.press('Control+Alt+f');
            input = await waitForQuickInput(page, 2000);
        }).toPass({ timeout: 15000 });
        await input.focus();

        // Type prefix of commit1
        const commit1Id = nodes.commit1.changeId;
        const prefix = commit1Id.substring(0, 4);
        await input.fill(prefix);
        await page.keyboard.press('Enter');

        // Verification: A diff editor tab should open.
        await expect(page.getByRole('tab', { name: new RegExp(`f\\.txt \\(${prefix}`) })).toBeVisible({
            timeout: 10000,
        });
    });

    test('Compare File with Revision... (Arbitrary)', async () => {
        await openFileInEditor(page, 'f.txt');

        // Launch using keyboard shortcut with retry
        let input!: Locator;
        await expect(async () => {
            await page.keyboard.press('Control+Alt+f');
            input = await waitForQuickInput(page, 2000);
        }).toPass({ timeout: 15000 });
        await input.focus();

        // Type prefix of branchC1
        const branchC1Id = nodes.branchC1.changeId;
        const prefix = branchC1Id.substring(0, 4);
        await input.fill(prefix);
        await page.keyboard.press('Enter');

        // Verification: A diff editor tab should open.
        await expect(page.getByRole('tab', { name: new RegExp(`f\\.txt \\(${prefix}`) })).toBeVisible({
            timeout: 10000,
        });
    });
});
