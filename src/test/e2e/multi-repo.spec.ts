/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { buildGraph, type CommitId, TestRepo } from '../test-repo';
import {
    clickScmAction,
    focusJJLog,
    focusSCM,
    openFileInEditor,
    SCM_ACTIONS,
    test,
    waitForLogCommitRow,
    waitForTab,
} from './e2e-helpers';

test.describe('Multi-Repo Switching E2E', () => {
    let mainRepo: TestRepo;
    let secondRepo: TestRepo;
    let mainCommits: Record<string, CommitId>;
    let page: Page;

    test.beforeEach(async ({ vscode }) => {
        mainRepo = new TestRepo();
        mainRepo.init();

        // 1. Set up graph for main repo
        mainCommits = await buildGraph(mainRepo, [
            { label: 'main-base', description: 'main base commit', files: { 'main_file.txt': 'main content' } },
            {
                label: 'main-wc',
                parents: ['main-base'],
                description: 'main WC message',
                files: { 'main_file.txt': 'modified main content' },
                isCurrentWorkingCopy: true,
            },
        ]);

        // 2. Set up second repo as a sibling repo
        secondRepo = new TestRepo();
        secondRepo.init();

        // 3. Set up graph for second repo
        await buildGraph(secondRepo, [
            { label: 'second-base', description: 'second base commit', files: { 'second_file.txt': 'second content' } },
            {
                label: 'second-wc',
                parents: ['second-base'],
                description: 'second WC message',
                files: { 'second_file.txt': 'modified second content' },
                isCurrentWorkingCopy: true,
            },
        ]);

        // 4. Create a multi-root code-workspace file
        const workspaceConfigPath = path.join(mainRepo.path, 'multi.code-workspace');
        fs.writeFileSync(
            workspaceConfigPath,
            JSON.stringify(
                {
                    folders: [{ path: mainRepo.path }, { path: secondRepo.path }],
                },
                null,
                2,
            ),
        );

        // Fake repo object with path pointing to the .code-workspace file
        const fakeRepo = {
            path: workspaceConfigPath,
        };

        const setup = await vscode.openWorkspace(fakeRepo, {
            'workbench.editor.enablePreview': false,
        });
        page = setup.page;
    });

    test.afterEach(async () => {
        if (secondRepo) {
            secondRepo.dispose();
        }
        if (mainRepo) {
            mainRepo.dispose();
        }
    });

    test('automatic repository switching when focusing different editor types', async ({ vscode }) => {
        const mainRepoFolderName = path.basename(mainRepo.path);
        const secondRepoFolderName = path.basename(secondRepo.path);

        // Verify initial focused repository is main repo by checking log view
        await focusJJLog(page);
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${mainRepoFolderName})` }).first()).toBeVisible({
            timeout: 5000,
        });
        await waitForLogCommitRow(page, 'main base commit');

        // Open second_file.txt from Explorer to trigger switch
        await openFileInEditor(vscode, page, 'second_file.txt');

        // Verify repository manager automatically switched focus to the second repo
        await focusJJLog(page);
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${secondRepoFolderName})` }).first()).toBeVisible(
            { timeout: 5000 },
        );
        await waitForLogCommitRow(page, 'second base commit');

        // Now open main_file.txt from Explorer to switch back
        await openFileInEditor(vscode, page, 'main_file.txt');

        // Verify focus switched back to main repo
        await focusJJLog(page);
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${mainRepoFolderName})` }).first()).toBeVisible({
            timeout: 5000,
        });
        await waitForLogCommitRow(page, 'main base commit');

        // ----------------------------------------------------
        // 2. Switching using Commit Details custom editors
        // ----------------------------------------------------

        // Open main commit details (from mainRepo)
        await focusJJLog(page);
        const mainBaseRow = await waitForLogCommitRow(page, 'main base commit');
        await mainBaseRow.click();
        const mainShortId = mainCommits['main-base'].changeId.substring(0, 3);
        await waitForTab(page, new RegExp(`^Commit: ${mainShortId}`));

        // Click second_file.txt tab (from secondRepo) to switch active repo to secondRepo
        const secondFileTab = page.getByRole('tab', { name: 'second_file.txt' });
        await secondFileTab.click();

        // Verify active repo switched to secondRepo
        await focusJJLog(page);
        await waitForLogCommitRow(page, 'second base commit');

        // Click Commit details tab (from mainRepo) to switch back to mainRepo
        const mainCommitTab = page.getByRole('tab', { name: new RegExp(`^Commit: ${mainShortId}`) });
        await mainCommitTab.click();

        // Verify active repo switched to mainRepo
        await focusJJLog(page);
        await waitForLogCommitRow(page, 'main base commit');

        // Click second_file.txt tab again to switch back to secondRepo
        await secondFileTab.click();

        // Verify active repo switched to secondRepo
        await focusJJLog(page);
        await waitForLogCommitRow(page, 'second base commit');
    });

    test('automatic repository switching when clicking inline focus button in SCM pane', async () => {
        const mainRepoFolderName = path.basename(mainRepo.path);
        const secondRepoFolderName = path.basename(secondRepo.path);

        // Verify initial focused repository is main repo by checking log view
        await focusJJLog(page);
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${mainRepoFolderName})` }).first()).toBeVisible({
            timeout: 5000,
        });
        await waitForLogCommitRow(page, 'main base commit');

        // Open SCM view
        await focusSCM(page);

        const secondRepoRowName = new RegExp(`Jujutsu \\(${secondRepoFolderName}\\)`);
        await clickScmAction(page, secondRepoRowName, SCM_ACTIONS.FocusRepository);

        // Verify repository manager automatically switched focus to the second repo by checking log view
        await focusJJLog(page);
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${secondRepoFolderName})` }).first()).toBeVisible(
            { timeout: 5000 },
        );
        await waitForLogCommitRow(page, 'second base commit');

        // Click focus inline action button on the main repo's row
        await focusSCM(page);
        const mainRepoRowName = new RegExp(`Jujutsu \\(${mainRepoFolderName}\\)`);
        await clickScmAction(page, mainRepoRowName, SCM_ACTIONS.FocusRepository);

        // Verify repository manager automatically switched focus back to the main repo by checking log view
        await focusJJLog(page);
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${mainRepoFolderName})` }).first()).toBeVisible({
            timeout: 5000,
        });
        await waitForLogCommitRow(page, 'main base commit');
    });
});
