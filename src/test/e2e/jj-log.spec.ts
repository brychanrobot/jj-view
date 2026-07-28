/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from '@playwright/test';
import { buildGraph, ROOT_ID, TestRepo } from '../test-repo';
import {
    clickLogAction,
    dragAndDrop,
    focusJJLog,
    getLogWebview,
    pickQuickPickItem,
    test,
    triggerRefresh,
    waitForLogCommitRow,
    waitForLogPill,
    waitForTree,
    waitForWebviewCommitRemoved,
    waitForWebviewWorkingCopy,
} from './e2e-helpers';

test.describe('JJ Log Pane E2E', () => {
    test('Webview Initialization & Rendering', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            {
                label: 'side_branch',
                parents: ['initial'],
                description: 'side branch commit',
                files: { 'file2.txt': 'base2' },
            },
            {
                label: 'wc',
                parents: ['initial'],
                description: 'working tree',
                files: { 'file.txt': 'mod' },
                isCurrentWorkingCopy: true,
                bookmarks: ['main'],
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusJJLog(page);
        const webview = await getLogWebview(page);

        // Assert all commit descriptions are present
        await expect(await waitForLogCommitRow(page, 'initial setup')).toBeVisible();
        await expect(await waitForLogCommitRow(page, 'side branch commit')).toBeVisible();
        await expect(await waitForLogCommitRow(page, 'working tree')).toBeVisible();

        // Assert Working Copy row is styled bold
        const wcDesc = webview.locator('.working-copy .commit-desc');
        await expect(wcDesc).toHaveCSS('font-weight', '700' /* bold */);

        // Assert Bookmark pill is present inside the working copy row
        await waitForLogPill(page, 'main', 'bookmark');
    });

    test('Pane Header Actions: Undo and New Merge Change', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const dummyId = repo.getChangeId('@');
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            { label: 'side_branch', parents: ['initial'], description: 'side branch', files: { 'file2.txt': 'base2' } },
            {
                label: 'wc',
                parents: ['initial'],
                description: 'working tree',
                files: { 'file.txt': 'mod' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusJJLog(page);
        // 1. New Merge Change (Requires Multi-select)
        const sideBranchRow = await waitForLogCommitRow(page, { changeId: nodes.side_branch.changeId });
        const wcRow = await waitForLogCommitRow(page, { changeId: nodes.wc.changeId });

        // Click the first one normally, the second with Control
        await sideBranchRow.click();
        await expect(sideBranchRow).toHaveAttribute('data-selected', 'true');

        await wcRow.click({ modifiers: ['Control'] });
        await expect(wcRow).toHaveAttribute('data-selected', 'true');

        // Click the native 'New Merge Change' header action
        // name-based locator is more robust for VS Code header actions
        const mergeAction = page.getByRole('button', { name: 'New Merge Change' }).first();
        await expect(mergeAction).toBeEnabled();
        await mergeAction.click();

        // Assert via repo that a new merge commit was created with correct parents
        await expect(async () => {
            const parents = repo.getParents('@');
            expect(parents).toContain(nodes.side_branch.changeId);
            expect(parents).toContain(nodes.wc.changeId);
        }).toPass({ timeout: 5000 });

        // Verify full tree: [merge, wc, side_branch, initial, dummy]
        const mergeChangeId = repo.getChangeId('@');
        await waitForTree(repo, [
            {
                isWorkingCopy: true,
                changeId: mergeChangeId,
                description: '(empty)',
                parents: [nodes.side_branch.changeId, nodes.wc.changeId],
            },
            { changeId: nodes.wc.changeId, description: 'working tree', parents: nodes.initial.changeId },
            { changeId: nodes.side_branch.changeId, description: 'side branch', parents: nodes.initial.changeId },
            { changeId: nodes.initial.changeId, description: 'initial setup', parents: dummyId },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);

        // 2. Undo
        const undoAction = page.getByRole('button', { name: 'Undo' }).first();
        await undoAction.click();

        // Assert the merge change was undone accurately
        await waitForTree(repo, [
            {
                isWorkingCopy: true,
                changeId: nodes.wc.changeId,
                description: 'working tree',
                parents: nodes.initial.changeId,
            },
            { changeId: nodes.side_branch.changeId, description: 'side branch', parents: nodes.initial.changeId },
            { changeId: nodes.initial.changeId, description: 'initial setup', parents: dummyId },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
    });

    test('Hover Actions: New Child, Squash, Abandon', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const dummyId = repo.getChangeId('@');
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            { label: 'branch', parents: ['initial'], description: 'branch commit', files: { 'file2.txt': 'base2' } },
            {
                label: 'wc',
                parents: ['branch'],
                description: 'working tree',
                files: { 'file.txt': 'mod' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusJJLog(page);

        // 1. New Child
        const branchId = nodes.branch.changeId;
        await clickLogAction(page, { changeId: branchId }, 'New Child');

        let childId = '';
        await expect(async () => {
            const currentId = repo.getChangeId('@');
            // Ensure @ has actually moved away from wc
            expect(currentId).not.toBe(nodes.wc.changeId);
            childId = currentId;
        }).toPass({ timeout: 10000 });

        // Make a file change in the child so it's not abandoned by 'jj edit'
        // but keep description empty so 'jj squash' stays silent
        repo.writeFile('child.txt', 'child content');

        // Tree: [new_child(@), wc, branch, initial, dummy]
        await waitForTree(repo, [
            { isWorkingCopy: true, changeId: childId, description: '(empty)', parents: nodes.branch.changeId },
            { changeId: nodes.wc.changeId, description: 'working tree', parents: nodes.branch.changeId },
            { changeId: nodes.branch.changeId, description: 'branch commit', parents: nodes.initial.changeId },
            { changeId: nodes.initial.changeId, description: 'initial setup', parents: dummyId },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
        await waitForWebviewWorkingCopy(page, childId);

        // 2. Prepare for squash: move working copy away from the new child
        const initialId = nodes.initial.changeId;
        await clickLogAction(page, { changeId: initialId }, 'Edit Commit');

        // Tree is the same commits, just @ moved. Order: [child, wc, branch, initial, dummy]
        await waitForTree(repo, [
            { changeId: childId, description: '(empty)', parents: nodes.branch.changeId },
            { changeId: nodes.wc.changeId, description: 'working tree', parents: nodes.branch.changeId },
            { changeId: nodes.branch.changeId, description: 'branch commit', parents: nodes.initial.changeId },
            { isWorkingCopy: true, changeId: nodes.initial.changeId, description: 'initial setup', parents: dummyId },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
        await waitForWebviewWorkingCopy(page, initialId);

        // 3. Squash the child into branch
        await clickLogAction(page, { changeId: childId }, 'Squash');

        // After squash: child is gone. branch has its changes.
        await waitForTree(repo, [
            { changeId: nodes.wc.changeId, description: 'working tree', parents: nodes.branch.changeId },
            { changeId: nodes.branch.changeId, description: 'branch commit', parents: nodes.initial.changeId },
            { isWorkingCopy: true, changeId: nodes.initial.changeId, description: 'initial setup', parents: dummyId },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
        await waitForWebviewCommitRemoved(page, childId);

        // 4. Abandon the branch commit
        await clickLogAction(page, { changeId: branchId }, 'Abandon');

        // After abandon branch: branch is gone. wc (child of branch) becomes child of initial.
        // Tree: [wc, initial(@)]
        await waitForTree(repo, [
            { changeId: nodes.wc.changeId, description: 'working tree', parents: nodes.initial.changeId },
            { isWorkingCopy: true, changeId: nodes.initial.changeId, description: 'initial setup', parents: dummyId },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
        await waitForWebviewCommitRemoved(page, branchId);
    });

    test('Multi-select and Drag & Drop (Rebase)', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            {
                label: 'target',
                parents: ['initial'],
                description: 'target branch',
                files: { 'file_target.txt': 'target' },
            },
            {
                label: 'source',
                parents: ['initial'],
                description: 'source branch',
                files: { 'file_source.txt': 'source' },
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusJJLog(page);

        const sourceRow = await waitForLogCommitRow(page, { changeId: nodes.source.changeId });
        const targetRow = await waitForLogCommitRow(page, { changeId: nodes.target.changeId });

        await sourceRow.scrollIntoViewIfNeeded();
        await targetRow.scrollIntoViewIfNeeded();

        // Drag source onto target to rebase
        await dragAndDrop(page, { source: sourceRow, target: targetRow });

        // Verify rebase via repo
        await expect(async () => {
            // Check 'source' parent is now 'target'
            const parents = repo.getParents(nodes.source.changeId);
            expect(parents).toContain(nodes.target.changeId);
        }).toPass({ timeout: 10000 });
    });

    test('Drag and Drop Commit with s key squashes source into target', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const dummyId = repo.getChangeId('@');
        const nodes = await buildGraph(repo, [
            { label: 'target', description: 'target commit', files: { 'target.txt': 'base' } },
            {
                label: 'source',
                parents: ['target'],
                description: 'source commit',
                files: { 'source.txt': 'mod' },
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);
        await focusJJLog(page);

        const sourceRow = await waitForLogCommitRow(page, { changeId: nodes.source.changeId });
        const targetRow = await waitForLogCommitRow(page, { changeId: nodes.target.changeId });

        await dragAndDrop(page, { source: sourceRow, target: targetRow, key: 's' });

        await waitForTree(repo, [
            { isWorkingCopy: true, changeId: '*', description: '(empty)', parents: nodes.target.changeId },
            {
                changeId: nodes.target.changeId,
                description: 'target commit',
                parents: dummyId,
                files: { 'target.txt': 'base', 'source.txt': 'mod' },
            },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
    });

    test('Drag and Drop Commit with Shift+s key squashes source onto target', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const dummyId = repo.getChangeId('@');
        const nodes = await buildGraph(repo, [
            { label: 'target', description: 'target commit', files: { 'target.txt': 'base' } },
            {
                label: 'source',
                parents: ['root()'],
                description: 'source commit',
                files: { 'source.txt': 'mod' },
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);
        await focusJJLog(page);

        const sourceRow = await waitForLogCommitRow(page, { changeId: nodes.source.changeId });
        const targetRow = await waitForLogCommitRow(page, { changeId: nodes.target.changeId });

        await dragAndDrop(page, { source: sourceRow, target: targetRow, key: 'Shift+s' });

        await waitForTree(repo, [
            { isWorkingCopy: true, changeId: '*', description: '(empty)', parents: ROOT_ID },
            {
                changeId: '*',
                description: 'source commit',
                parents: nodes.target.changeId,
                files: { 'source.txt': 'mod' },
            },
            {
                changeId: nodes.target.changeId,
                description: 'target commit',
                parents: dummyId,
                files: { 'target.txt': 'base' },
            },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
    });

    test('Drag and Drop Commit with d key duplicates source onto target', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const dummyId = repo.getChangeId('@');
        const nodes = await buildGraph(repo, [
            { label: 'target', description: 'target commit', files: { 'target.txt': 'base' } },
            {
                label: 'source',
                parents: ['root()'],
                description: 'source to duplicate',
                files: { 'source.txt': 'mod' },
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);
        await focusJJLog(page);

        const sourceRow = await waitForLogCommitRow(page, { changeId: nodes.source.changeId });
        const targetRow = await waitForLogCommitRow(page, { changeId: nodes.target.changeId });

        await dragAndDrop(page, { source: sourceRow, target: targetRow, key: 'd' });

        await waitForTree(repo, [
            {
                changeId: '*',
                description: 'source to duplicate',
                parents: nodes.target.changeId,
                files: { 'source.txt': 'mod' },
            },
            {
                isWorkingCopy: true,
                changeId: nodes.source.changeId,
                description: 'source to duplicate',
                parents: ROOT_ID,
                files: { 'source.txt': 'mod' },
            },
            {
                changeId: nodes.target.changeId,
                description: 'target commit',
                parents: dummyId,
                files: { 'target.txt': 'base' },
            },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
    });

    test('Delete Bookmark (Command Palette/Quick Pick Flow)', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            {
                label: 'wc',
                parents: ['initial'],
                description: 'working tree',
                files: { 'file.txt': 'mod' },
                isCurrentWorkingCopy: true,
            },
        ]);

        // 1. Create a local bookmark via CLI
        repo.bookmark('local-to-delete', nodes.wc.changeId);

        const { page } = await vscode.openWorkspace(repo);

        await focusJJLog(page);
        await triggerRefresh(page);

        // 2. Verify bookmark pill is visible
        const bookmarkPill = await waitForLogPill(page, 'local-to-delete', 'bookmark');
        await expect(bookmarkPill).toBeVisible();

        // 3. Trigger Delete Bookmark via keyboard shortcut
        await page.keyboard.press('Control+Alt+D');

        // 4. Select the bookmark to delete in the Quick Pick
        await pickQuickPickItem(page, 'local-to-delete');

        // 5. Verify the bookmark pill disappears from the webview
        await expect(bookmarkPill).toBeHidden({ timeout: 10000 });
    });

    test('Drag & Drop Bookmark (Advance/Move)', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            {
                label: 'wc',
                parents: ['initial'],
                description: 'working tree',
                files: { 'file.txt': 'mod' },
                isCurrentWorkingCopy: true,
            },
        ]);

        // 1. Create a bookmark on initial commit
        repo.bookmark('drag-bookmark', nodes.initial.changeId);

        const { page } = await vscode.openWorkspace(repo);

        await focusJJLog(page);

        // 2. Locate the draggable bookmark pill and target commit row (move forward)
        const bookmarkPill = await waitForLogPill(page, 'drag-bookmark', 'bookmark');
        const wcRow = await waitForLogCommitRow(page, { changeId: nodes.wc.changeId });

        // 3. Drag the bookmark pill onto the wc commit row (move forward)
        await dragAndDrop(page, { source: bookmarkPill, target: wcRow });

        // 4. Verify bookmark moved to wc in local repository
        const wcCommitId = repo.getCommitId(nodes.wc.changeId);
        await expect(async () => {
            expect(repo.getCommitId('drag-bookmark')).toBe(wcCommitId);
        }).toPass({ timeout: 10000 });

        // 5. Drag it backward (from wc back onto initial commit)
        const initialRow = await waitForLogCommitRow(page, { changeId: nodes.initial.changeId });
        // Re-fetch the bookmark pill since the webview refreshes after the move command
        const bookmarkPillAfterMove = await waitForLogPill(page, 'drag-bookmark', 'bookmark');
        await dragAndDrop(page, { source: bookmarkPillAfterMove, target: initialRow });

        // 6. Verify bookmark moved back to initial commit in local repository
        const initialCommitId = repo.getCommitId(nodes.initial.changeId);
        await expect(async () => {
            expect(repo.getCommitId('drag-bookmark')).toBe(initialCommitId);
        }).toPass({ timeout: 10000 });
    });
});
