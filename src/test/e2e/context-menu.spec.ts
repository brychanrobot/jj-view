/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { buildGraph, type CommitId, TestRepo } from '../test-repo';
import {
    entry,
    expectModifiedFiles,
    expectTree,
    focusJJLog,
    getLogWebview,
    launchVSCode,
    ROOT_ID,
    rightClickAndSelect,
    selectCommits,
    triggerRefresh,
    waitForLogCommitRow,
    waitForLogPill,
    waitForTab,
} from './e2e-helpers';

test.describe('JJ Log Context Menu E2E', () => {
    let repo: TestRepo;
    let app: ElectronApplication;
    let page: Page;
    let userDataDir: string;
    let nodes: Record<string, CommitId>;
    let dummyId: string;

    test.beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        repo.writeFile('dummy.txt', 'dummy content');
        repo.describe('dummy');
        dummyId = repo.getChangeId('@');

        // Setup a predictable graph
        nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'base', 'f2.txt': 'base2' } },
            { label: 'commit1', parents: ['initial'], description: 'commit1', files: { 'a.txt': 'a content' } },
            {
                label: 'commit2',
                parents: ['initial'],
                description: 'commit2',
                files: { 'b.txt': 'b content', 'b2.txt': 'b2 content' },
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

    test('Abandon and Undo', async () => {
        await waitForLogCommitRow(page, 'commit2');

        const commit2Id = nodes.commit2.changeId;
        const commit1Id = nodes.commit1.changeId;
        const initialId = nodes.initial.changeId;

        // Abandon commit 2
        const commit2Row = await waitForLogCommitRow(page, 'commit2');
        await rightClickAndSelect(page, commit2Row, 'Abandon');

        await expectTree(repo, [
            `@ ${entry('*', '(empty)', initialId)}`,
            entry(commit1Id, 'commit1', initialId),
            entry(initialId, 'initial', dummyId),
            entry(dummyId, 'dummy', ROOT_ID),
        ]);
        // Undo — the button is a header action on the JJ Log pane
        const undoBtn = page.getByRole('button', { name: 'Undo' }).first();
        await expect(undoBtn).toBeVisible({ timeout: 5000 });
        await undoBtn.click();

        // After undo, commit2 should be restored as the working copy
        await expectTree(repo, [
            `@ ${entry(commit2Id, 'commit2', initialId)}`,
            entry(commit1Id, 'commit1', initialId),
            entry(initialId, 'initial', dummyId),
            entry(dummyId, 'dummy', ROOT_ID),
        ]);
    });

    test('New Before (Single)', async () => {
        await waitForLogCommitRow(page, 'commit1');

        const commit2Id = nodes.commit2.changeId;
        const commit1Id = nodes.commit1.changeId;
        const initialId = nodes.initial.changeId;

        // New Before initial
        const initialRow = await waitForLogCommitRow(page, 'initial');
        await rightClickAndSelect(page, initialRow, 'New Before');

        // After "New Before" initial:
        // root -> dummyId -> middle (@) -> initial -> {commit1, commit2}
        await expect(async () => {
            await expectTree(repo, [
                entry(commit2Id, 'commit2', initialId),
                entry(commit1Id, 'commit1', initialId),
                entry(initialId, 'initial', '*'),
                `@ ${entry('*', '(empty)', dummyId)}`,
                entry(dummyId, 'dummy', ROOT_ID),
            ]);
        }).toPass();
    });

    test('Multi-select Abandon', async () => {
        await waitForLogCommitRow(page, 'commit2');

        const commit2Row = await waitForLogCommitRow(page, 'commit2');
        const commit1Row = await waitForLogCommitRow(page, 'commit1');
        const initialId = nodes.initial.changeId;

        // Select both
        await selectCommits([commit2Row, commit1Row]);

        // Right click commit 1 and abandon
        await rightClickAndSelect(page, commit1Row, 'Abandon');

        await expectTree(repo, [
            `@ ${entry('*', '(empty)', initialId)}`,
            entry(initialId, 'initial', dummyId),
            entry(dummyId, 'dummy', ROOT_ID),
        ]);
    });

    test('Multi-select New Before', async () => {
        const webview = await getLogWebview(page);

        await expect(webview.locator('.commit-row', { hasText: 'commit2' })).toBeVisible();

        const commit2Row = webview.locator('.commit-row', { hasText: 'commit2' });
        const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });
        const commit2Id = nodes.commit2.changeId;
        const commit1Id = nodes.commit1.changeId;
        const initialId = nodes.initial.changeId;

        // Select both
        await selectCommits([commit2Row, commit1Row]);

        // Right click and New Before
        await rightClickAndSelect(page, commit2Row, 'New Before');

        // After "New Before" on multi-select [commit2, commit1]: a new empty commit
        // is inserted before both (as their new parent), and @ moves there.
        // Tree: root -> dummyId -> initial -> middle (@) -> {commit1, commit2}
        await expect(async () => {
            await expectTree(repo, [
                entry(commit1Id, 'commit1', '*'),
                entry(commit2Id, 'commit2', '*'),
                `@ ${entry('*', '(empty)', initialId)}`,
                entry(initialId, 'initial', dummyId),
                entry(dummyId, 'dummy', ROOT_ID),
            ]);
        }).toPass();
    });

    test('New After (Single)', async () => {
        const webview = await getLogWebview(page);

        await expect(webview.locator('.commit-row', { hasText: 'initial' })).toBeVisible();

        const commit2Id = nodes.commit2.changeId;
        const commit1Id = nodes.commit1.changeId;
        const initialId = nodes.initial.changeId;

        // New After initial
        const initialRow = webview.locator('.commit-row', { hasText: 'initial' });
        await rightClickAndSelect(page, initialRow, 'New After');

        // After "New After" initial:
        // root -> dummyId -> initial -> middle (@) -> {commit1, commit2}
        await expect(async () => {
            await expectTree(repo, [
                entry(commit1Id, 'commit1', '*'),
                entry(commit2Id, 'commit2', '*'),
                `@ ${entry('*', '(empty)', initialId)}`,
                entry(initialId, 'initial', dummyId),
                entry(dummyId, 'dummy', ROOT_ID),
            ]);
        }).toPass();
    });

    test('Multi-select New After', async () => {
        const commit1Id = nodes.commit1.changeId;
        const commit2Id = nodes.commit2.changeId;
        const initialId = nodes.initial.changeId;

        // Create children so "insert after" has something to rebase
        repo.new([commit1Id]);
        repo.describe('child1');
        const child1Id = repo.getChangeId('@');

        repo.new([commit2Id]);
        repo.describe('child2');
        const child2Id = repo.getChangeId('@');

        await triggerRefresh(page);

        const webview = await getLogWebview(page);
        await expect(webview.locator('.commit-row', { hasText: 'child1' })).toBeVisible();

        const commit2Row = webview.locator('.commit-row', { hasText: 'commit2' });
        const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });

        // Select both
        await selectCommits([commit2Row, commit1Row]);

        // Right click and New After
        await rightClickAndSelect(page, commit2Row, 'New After');

        // After "New After" on multi-select [commit2, commit1]: a new empty commit
        // is inserted after both (as their new child).
        // Then child1 and child2 are rebased on top of the new commit.
        // Tree: root -> dummyId -> initial -> {commit1, commit2} -> middle (@) -> {child1, child2}
        await expect(async () => {
            await expectTree(repo, [
                entry(child1Id, 'child1', '*'),
                entry(child2Id, 'child2', '*'),
                expect.stringMatching(
                    new RegExp(`^@ [a-z0-9]+ \\[(${commit1Id},${commit2Id}|${commit2Id},${commit1Id})\\] \\(empty\\)$`),
                ),
                entry(commit2Id, 'commit2', initialId),
                entry(commit1Id, 'commit1', initialId),
                entry(initialId, 'initial', dummyId),
                entry(dummyId, 'dummy', ROOT_ID),
            ]);
        }).toPass();
    });

    test('Edit', async () => {
        const webview = await getLogWebview(page);
        const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });
        const commit1Id = nodes.commit1.changeId;

        // Edit commit 1
        await rightClickAndSelect(page, commit1Row, 'Edit');

        // Verification: @ should move to commit1
        await expect(async () => {
            const currentId = repo.getChangeId('@');
            expect(currentId).toBe(commit1Id);
        }).toPass();
    });

    test('Duplicate', async () => {
        const webview = await getLogWebview(page);
        const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });

        // Duplicate commit 1
        await rightClickAndSelect(page, commit1Row, 'Duplicate');

        // Verification: a new commit should be created with the same parent
        // Note: jj duplicate does NOT move @.
        // New duplicate (latest) -> commit2 (@) -> commit1 (original)
        const commit2Id = nodes.commit2.changeId;
        const commit1Id = nodes.commit1.changeId;
        const initialId = nodes.initial.changeId;

        await expectTree(repo, [
            expect.stringMatching(new RegExp(`^[a-z0-9]+ \\[${initialId}\\] commit1$`)),
            `@ ${entry(commit2Id, 'commit2', initialId)}`,
            entry(commit1Id, 'commit1', initialId),
            entry(initialId, 'initial', dummyId),
            entry(dummyId, 'dummy', ROOT_ID),
        ]);
    });

    test('New Merge Change', async () => {
        const webview = await getLogWebview(page);
        const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });
        const commit2Row = webview.locator('.commit-row', { hasText: 'commit2' });
        const commit1Id = nodes.commit1.changeId;
        const commit2Id = nodes.commit2.changeId;
        const initialId = nodes.initial.changeId;

        // Select both
        await selectCommits([commit1Row, commit2Row]);

        // Merge selection
        await rightClickAndSelect(page, commit1Row, 'New Merge Change');

        // Verification: a new merge commit should be created
        await expect(async () => {
            await expectTree(repo, [
                `@ ${entry('*', '(empty)', [commit1Id, commit2Id])}`,
                entry(commit2Id, 'commit2', initialId),
                entry(commit1Id, 'commit1', initialId),
                entry(initialId, 'initial', dummyId),
                entry(dummyId, 'dummy', ROOT_ID),
            ]);
        }).toPass();
    });

    test('Rebase onto Selected', async () => {
        const webview = await getLogWebview(page);
        const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });
        const commit2Row = webview.locator('.commit-row', { hasText: 'commit2' });
        const commit1Id = nodes.commit1.changeId;
        const commit2Id = nodes.commit2.changeId;
        const initialId = nodes.initial.changeId;

        // Select commit2 as the destination, then right-click commit1 to rebase it
        await selectCommits([commit2Row]);
        await rightClickAndSelect(page, commit1Row, 'Rebase onto Selected');

        // Verification: commit1 should now be a child of commit2
        await expect(async () => {
            await expectTree(repo, [
                entry(commit1Id, 'commit1', commit2Id),
                `@ ${entry(commit2Id, 'commit2', initialId)}`,
                entry(initialId, 'initial', dummyId),
                entry(dummyId, 'dummy', ROOT_ID),
            ]);
        }).toPass();
    });

    test('Set Bookmark', async () => {
        const webview = await getLogWebview(page);
        const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });

        // Set bookmark on commit 1 (retry the whole sequence)
        await expect(async () => {
            await rightClickAndSelect(page, commit1Row, 'Set Bookmark');

            // Wait for QuickPick/InputBox to appear. The InputBox has an input.input element.
            const quickInput = page.locator('.quick-input-widget');
            const input = quickInput.locator('input.input');
            await expect(input).toBeVisible({ timeout: 5000 });

            // Type the bookmark name
            await input.focus();
            await page.keyboard.type('my-bookmark', { delay: 50 });
            await page.keyboard.press('Enter');

            // Verification: bookmark pill should appear in the webview
            await waitForLogPill(page, 'my-bookmark', 'bookmark');
        }).toPass({ timeout: 30000 });
    });

    test('Absorb', async () => {
        const commit1Id = nodes.commit1.changeId;
        const webview = await getLogWebview(page);
        // Move @ to commit1 and modify a file
        repo.edit(commit1Id);
        await triggerRefresh(page);
        repo.writeFile('f.txt', 'modified in wc');

        await expect(async () => {
            // Re-locate the row in each poll to handle refreshes/virtualization
            const row = webview.locator('.commit-row', { hasText: 'commit1' });
            // The working-copy class is the most reliable indicator
            await expect(row).toHaveClass(/working-copy/, { timeout: 5000 });
        }, 'Absorb setup failed: commit1 did not become the working copy').toPass({ timeout: 30000 });

        // Re-locate one last time for the context menu action
        const finalRow = webview.locator('.commit-row', { hasText: 'commit1' });
        // Absorb into commit 1
        await rightClickAndSelect(page, finalRow, 'Absorb');

        // Verification: commit 1 should now have the change, and f.txt should no longer be modified in @
        await expect(async () => {
            const content = repo.getFileContent(commit1Id, 'f.txt');
            expect(content).toBe('modified in wc');
            const wcDiff = repo.getDiffSummary('@');
            expect(wcDiff).not.toContain('f.txt');
        }).toPass();
    });

    test('Show Multi-File Diff', async () => {
        // Target 'initial' which has actual file changes (f.txt added)
        const initialRow = await waitForLogCommitRow(page, { changeId: nodes.initial.changeId });

        // Show Multi-File Diff
        await rightClickAndSelect(page, initialRow, 'Show Multi-File Diff');

        // Verification: A diff editor should open.
        const shortId = nodes.initial.changeId.substring(0, 3);
        await waitForTab(page, new RegExp(`^${shortId}`));

        await expectModifiedFiles(page, ['f.txt', 'f2.txt']);
    });

    test('Compare with Working Copy', async () => {
        const initialRow = await waitForLogCommitRow(page, { changeId: nodes.initial.changeId });

        // Select Compare All Files with Revision...
        await rightClickAndSelect(page, initialRow, 'Compare All Files with Revision...');

        // Verification: A diff editor tab should open.
        const shortId = nodes.initial.changeId.substring(0, 3);
        await waitForTab(page, new RegExp(`^Compare ${shortId}`));

        await expectModifiedFiles(page, ['b.txt', 'b2.txt']);
    });

    test.describe('Upload Action', () => {
        test('Upload fails with invalid remote', async () => {
            const webview = await getLogWebview(page);
            const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });

            // 1. Add an invalid 'origin' remote (non-existent local path) to force immediate failure
            repo.addRemote('origin', '/tmp/non-existent-jj-remote-directory');
            repo.config('remotes.origin.auto-track-bookmarks', '"*"');
            repo.bookmark('fail-branch', nodes.commit1.changeId);

            // 2. Un-hide notifications toast locally
            await page.addStyleTag({
                content: '.notifications-toasts { display: block !important; visibility: visible !important; }',
            });

            // 3. Trigger "Upload"
            await rightClickAndSelect(page, commit1Row, 'Upload');

            // 4. Assert "Upload failed"
            const toastContainer = page.locator('.notifications-toasts');
            await expect(toastContainer).toContainText(/Upload failed/i, { timeout: 20000 });
            await page.keyboard.press('Escape');
        });

        test('Upload succeeds with local remote', async () => {
            const webview = await getLogWebview(page);
            const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });

            // 1. Create and initialize a remote repository
            const remoteRepo = new TestRepo();
            remoteRepo.init();

            // 2. Add as 'origin' to the main repo
            repo.addRemote('origin', remoteRepo.path);

            // 3. Configure jj to push new bookmarks
            repo.config('remotes.origin.auto-track-bookmarks', '"*"');

            // 4. Create a bookmark on commit1
            const changeId = nodes.commit1.changeId;
            repo.bookmark('test-branch', changeId);

            // 5. Trigger "Upload"
            await rightClickAndSelect(page, commit1Row, 'Upload');

            // 6. Verify the commit reached the remote repo
            const pushedCommitId = repo.getCommitId('test-branch');

            await expect
                .poll(
                    async () => {
                        try {
                            // Import git changes into the remote jj repo so it sees the push
                            remoteRepo.gitImport();
                            const remoteCommitId = remoteRepo.getCommitId('test-branch');
                            return remoteCommitId === pushedCommitId;
                        } catch {
                            return false;
                        }
                    },
                    { timeout: 20000 },
                )
                .toBe(true);

            remoteRepo.dispose();
        });
    });
});
