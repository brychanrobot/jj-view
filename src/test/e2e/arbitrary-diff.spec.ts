/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { type Page, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { buildGraph, type CommitId, TestRepo } from '../test-repo';
import {
    expectModifiedFiles,
    focusJJLog,
    launchVSCode,
    openFileInEditor,
    openQuickInputWithShortcut,
    pickQuickPickItem,
    waitForTab,
} from './e2e-helpers';

test.describe('Arbitrary Diff E2E', () => {
    let repo: TestRepo;
    let app: ElectronApplication;
    let page: Page;
    let userDataDir: string;
    let nodes: Record<string, CommitId>;

    async function compareWithRevision(
        page: Page,
        shortcut: string,
        searchQuery: string,
        tabNamePattern: RegExp,
        submitAsArbitraryText: boolean = false,
    ): Promise<void> {
        await openQuickInputWithShortcut(page, shortcut);
        await pickQuickPickItem(page, searchQuery, { submitAsArbitraryText });
        await waitForTab(page, tabNamePattern);
    }

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
        const commit1Id = nodes.commit1.changeId;
        await compareWithRevision(
            page,
            'Control+Alt+c',
            'commit1',
            new RegExp(`^Compare ${commit1Id.substring(0, 3)}`),
        );
        await expectModifiedFiles(page, ['f.txt']);
    });

    test('Compare All Files with Revision... (Arbitrary)', async () => {
        const branchC1Id = nodes.branchC1.changeId;
        await compareWithRevision(
            page,
            'Control+Alt+c',
            branchC1Id,
            new RegExp(`^Compare ${branchC1Id.substring(0, 3)}`),
            true,
        );
        await expectModifiedFiles(page, ['f.txt', 'g.txt']);
    });

    test('Compare File with Revision... (Ancestor)', async () => {
        await openFileInEditor(page, 'f.txt');
        const commit1Id = nodes.commit1.changeId;
        await compareWithRevision(
            page,
            'Control+Alt+f',
            'commit1',
            new RegExp(`f\\.txt \\(${commit1Id.substring(0, 3)}`),
        );
    });

    test('Compare File with Revision... (Arbitrary)', async () => {
        await openFileInEditor(page, 'f.txt');
        const branchC1Id = nodes.branchC1.changeId;
        await compareWithRevision(
            page,
            'Control+Alt+f',
            branchC1Id,
            new RegExp(`f\\.txt \\(${branchC1Id.substring(0, 3)}`),
            true,
        );
    });
});
