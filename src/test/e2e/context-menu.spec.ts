/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ElectronApplication } from 'playwright';
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import { TestRepo, buildGraph, type CommitId } from '../test-repo';
import { launchVSCode, focusJJLog, getLogWebview, expectTree, entry, rightClickAndSelect, ROOT_ID, selectCommits, triggerRefresh } from './e2e-helpers';

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
            { label: 'initial', description: 'initial', files: { 'f.txt': 'base' } },
            { label: 'commit1', parents: ['initial'], description: 'commit1', files: { 'a.txt': 'a content' } },
            { label: 'commit2', parents: ['initial'], description: 'commit2', files: { 'b.txt': 'b content' } }
        ]);

        const setup = await launchVSCode(repo);
        app = setup.app;
        page = setup.page;
        userDataDir = setup.userDataDir;

        await focusJJLog(page);
    });

    test.afterEach(async () => {
        if (app) await app.close();
        if (userDataDir) try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
        if (repo) repo.dispose();
    });

    test('Abandon and Undo', async () => {
        const webview = await getLogWebview(page);
        
        await expect(webview.locator('.commit-row', { hasText: 'commit2' })).toBeVisible();
        
        const commit2Id = nodes['commit2'].changeId;
        const commit1Id = nodes['commit1'].changeId;
        const initialId = nodes['initial'].changeId;

        // Abandon commit 2
        const commit2Row = webview.locator('.commit-row', { hasText: 'commit2' });
        await rightClickAndSelect(page, commit2Row, 'Abandon');

        await expectTree(repo, [
            '@ ' + entry('*', '(empty)', initialId),
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
            '@ ' + entry(commit2Id, 'commit2', initialId),
            entry(commit1Id, 'commit1', initialId),
            entry(initialId, 'initial', dummyId),
            entry(dummyId, 'dummy', ROOT_ID),
        ]);
    });

    test('New Before (Single)', async () => {
        const webview = await getLogWebview(page);
        
        await expect(webview.locator('.commit-row', { hasText: 'commit1' })).toBeVisible();
        
        const commit2Id = nodes['commit2'].changeId;
        const commit1Id = nodes['commit1'].changeId;
        const initialId = nodes['initial'].changeId;

        // New Before initial
        const initialRow = webview.locator('.commit-row', { hasText: 'initial' });
        await rightClickAndSelect(page, initialRow, 'New Before');

        // After "New Before" initial: 
        // root -> dummyId -> middle (@) -> initial -> {commit1, commit2}
        await expect(async () => {
            await expectTree(repo, [
                entry(commit2Id, 'commit2', initialId),
                entry(commit1Id, 'commit1', initialId),
                entry(initialId, 'initial', '*'),
                '@ ' + entry('*', '(empty)', dummyId),
                entry(dummyId, 'dummy', ROOT_ID),
            ]);
        }).toPass();
    });

    test('Multi-select Abandon', async () => {
        const webview = await getLogWebview(page);
        
        await expect(webview.locator('.commit-row', { hasText: 'commit2' })).toBeVisible();

        const commit2Row = webview.locator('.commit-row', { hasText: 'commit2' });
        const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });
        const initialId = nodes['initial'].changeId;

        // Select both
        await selectCommits([commit2Row, commit1Row]);

        // Right click commit 1 and abandon
        await rightClickAndSelect(page, commit1Row, 'Abandon');

        await expectTree(repo, [
            '@ ' + entry('*', '(empty)', initialId),
            entry(initialId, 'initial', dummyId),
            entry(dummyId, 'dummy', ROOT_ID),
        ]);
    });

    test('Multi-select New Before', async () => {
        const webview = await getLogWebview(page);
        
        await expect(webview.locator('.commit-row', { hasText: 'commit2' })).toBeVisible();

        const commit2Row = webview.locator('.commit-row', { hasText: 'commit2' });
        const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });
        const commit2Id = nodes['commit2'].changeId;
        const commit1Id = nodes['commit1'].changeId;
        const initialId = nodes['initial'].changeId;

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
                '@ ' + entry('*', '(empty)', initialId),
                entry(initialId, 'initial', dummyId),
                entry(dummyId, 'dummy', ROOT_ID),
            ]);
        }).toPass();
    });

    test('Edit', async () => {
        const webview = await getLogWebview(page);
        const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });
        const commit1Id = nodes['commit1'].changeId;

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
        const commit2Id = nodes['commit2'].changeId;
        const commit1Id = nodes['commit1'].changeId;
        const initialId = nodes['initial'].changeId;

        await expectTree(repo, [
            expect.stringMatching(new RegExp(`^[a-z0-9]+ \\[${initialId}\\] commit1$`)),
            '@ ' + entry(commit2Id, 'commit2', initialId),
            entry(commit1Id, 'commit1', initialId),
            entry(initialId, 'initial', dummyId),
            entry(dummyId, 'dummy', ROOT_ID),
        ]);
    });

    test('New Merge Change', async () => {
        const webview = await getLogWebview(page);
        const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });
        const commit2Row = webview.locator('.commit-row', { hasText: 'commit2' });
        const commit1Id = nodes['commit1'].changeId;
        const commit2Id = nodes['commit2'].changeId;
        const initialId = nodes['initial'].changeId;

        // Select both
        await selectCommits([commit1Row, commit2Row]);

        // Merge selection
        await rightClickAndSelect(page, commit1Row, 'New Merge Change');

        // Verification: a new merge commit should be created
        await expect(async () => {
            await expectTree(repo, [
                '@ ' + entry('*', '(empty)', [commit1Id, commit2Id]),
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
        const commit1Id = nodes['commit1'].changeId;
        const commit2Id = nodes['commit2'].changeId;
        const initialId = nodes['initial'].changeId;

        // Select commit2 as the destination, then right-click commit1 to rebase it
        await selectCommits([commit2Row]);
        await rightClickAndSelect(page, commit1Row, 'Rebase onto Selected');

        // Verification: commit1 should now be a child of commit2
        await expect(async () => {
            await expectTree(repo, [
                entry(commit1Id, 'commit1', commit2Id),
                '@ ' + entry(commit2Id, 'commit2', initialId),
                entry(initialId, 'initial', dummyId),
                entry(dummyId, 'dummy', ROOT_ID),
            ]);
        }).toPass();
    });

    test('Set Bookmark', async () => {
        const webview = await getLogWebview(page);
        const commit1Row = webview.locator('.commit-row', { hasText: 'commit1' });

        // Set bookmark on commit 1
        await rightClickAndSelect(page, commit1Row, 'Set Bookmark');
        
        // Wait for QuickPick/InputBox to appear
        await expect(page.locator('.quick-input-widget')).toBeVisible({ timeout: 5000 });
        await page.keyboard.type('my-bookmark', { delay: 50 });
        await page.keyboard.press('Enter');

        // Verification: bookmark pill should appear in the webview
        await expect(commit1Row.locator('.bookmark-pill', { hasText: 'my-bookmark' })).toBeVisible({ timeout: 10000 });
    });

    test('Absorb', async () => {
        const commit1Id = nodes['commit1'].changeId;
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
        }, "Absorb setup failed: commit1 did not become the working copy").toPass({ timeout: 30000 });
        
        // Re-locate one last time for the context menu action
        const finalRow = webview.locator('.commit-row', { hasText: 'commit1' });
        // Absorb into commit 1
        console.log("DEBUG TEST: Attempting to right-click and Absorb on commit1");
        await rightClickAndSelect(page, finalRow, 'Absorb');
        console.log("DEBUG TEST: rightClickAndSelect completed without throwing");

        // Verification: commit 1 should now have the change, and f.txt should no longer be modified in @
        await expect(async () => {
            const content = repo.getFileContent(commit1Id, 'f.txt');
            expect(content).toBe('modified in wc');
            const wcDiff = repo.getDiffSummary('@');
            expect(wcDiff).not.toContain('f.txt');
        }).toPass();
    });

    test('Show Multi-File Diff', async () => {
        const webview = await getLogWebview(page);
        // Target 'initial' which has actual file changes (f.txt added)
        const initialRow = webview.locator('.commit-row', { hasText: 'initial' });

        // Show Multi-File Diff
        await rightClickAndSelect(page, initialRow, 'Show Multi-File Diff');

        // Verification: A diff editor should open.
        const shortId = nodes['initial'].changeId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^${shortId}`) })).toBeVisible({ timeout: 10000 });
    });
});
