/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from '@playwright/test';
import { buildGraph, TestRepo } from '../test-repo';
import {
    clickLogAction,
    entry,
    expectTree,
    focusJJLog,
    getLogWebview,
    pickQuickPickItem,
    ROOT_ID,
    test,
    triggerRefresh,
    waitForLogCommitRow,
    waitForLogPill,
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

        try {
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
        } finally {
            repo.dispose();
        }
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

        try {
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
            await expect(async () => {
                const mergeChangeId = repo.getChangeId('@');
                await expectTree(repo, [
                    `@ ${entry(mergeChangeId, '(empty)', [nodes.side_branch.changeId, nodes.wc.changeId])}`,
                    entry(nodes.wc.changeId, 'working tree', nodes.initial.changeId),
                    entry(nodes.side_branch.changeId, 'side branch', nodes.initial.changeId),
                    entry(nodes.initial.changeId, 'initial setup', dummyId),
                    entry(dummyId, '(empty)', ROOT_ID),
                ]);
            }).toPass();

            // 2. Undo
            const undoAction = page.getByRole('button', { name: 'Undo' }).first();
            await undoAction.click();

            // Assert the merge change was undone accurately
            await expectTree(repo, [
                `@ ${entry(nodes.wc.changeId, 'working tree', nodes.initial.changeId)}`,
                entry(nodes.side_branch.changeId, 'side branch', nodes.initial.changeId),
                entry(nodes.initial.changeId, 'initial setup', dummyId),
                entry(dummyId, '(empty)', ROOT_ID),
            ]);
        } finally {
            repo.dispose();
        }
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

        try {
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
            // Order: child is newest head, wc is other head.
            await expect(async () => {
                const childId = repo.getChangeId('@');
                await expectTree(repo, [
                    `@ ${entry(childId, '(empty)', nodes.branch.changeId)}`,
                    entry(nodes.wc.changeId, 'working tree', nodes.branch.changeId),
                    entry(nodes.branch.changeId, 'branch commit', nodes.initial.changeId),
                    entry(nodes.initial.changeId, 'initial setup', dummyId),
                    entry(dummyId, '(empty)', ROOT_ID),
                ]);
            }).toPass();
            await waitForWebviewWorkingCopy(page, childId);

            // 2. Prepare for squash: move working copy away from the new child
            const initialId = nodes.initial.changeId;
            await clickLogAction(page, { changeId: initialId }, 'Edit Commit');

            // Tree is the same commits, just @ moved. Order: [child, wc, branch, initial, dummy]
            await expectTree(repo, [
                entry(childId, '(empty)', nodes.branch.changeId),
                entry(nodes.wc.changeId, 'working tree', nodes.branch.changeId),
                entry(nodes.branch.changeId, 'branch commit', nodes.initial.changeId),
                `@ ${entry(nodes.initial.changeId, 'initial setup', dummyId)}`,
                entry(dummyId, '(empty)', ROOT_ID),
            ]);
            await waitForWebviewWorkingCopy(page, initialId);

            // 3. Squash the child into branch
            await clickLogAction(page, { changeId: childId }, 'Squash');

            // After squash: child is gone. branch has its changes.
            await expectTree(repo, [
                entry(nodes.wc.changeId, 'working tree', nodes.branch.changeId),
                entry(nodes.branch.changeId, 'branch commit', nodes.initial.changeId),
                `@ ${entry(nodes.initial.changeId, 'initial setup', dummyId)}`,
                entry(dummyId, '(empty)', ROOT_ID),
            ]);
            await waitForWebviewCommitRemoved(page, childId);

            // 4. Abandon the branch commit
            await clickLogAction(page, { changeId: branchId }, 'Abandon');

            // After abandon branch: branch is gone. wc (child of branch) becomes child of initial.
            // Tree: [wc, initial(@)]
            await expectTree(repo, [
                entry(nodes.wc.changeId, 'working tree', nodes.initial.changeId),
                `@ ${entry(nodes.initial.changeId, 'initial setup', dummyId)}`,
                entry(dummyId, '(empty)', ROOT_ID),
            ]);
            await waitForWebviewCommitRemoved(page, branchId);
        } finally {
            repo.dispose();
        }
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

        try {
            await focusJJLog(page);

            const sourceRow = await waitForLogCommitRow(page, { changeId: nodes.source.changeId });
            const targetRow = await waitForLogCommitRow(page, { changeId: nodes.target.changeId });

            await sourceRow.scrollIntoViewIfNeeded();
            await targetRow.scrollIntoViewIfNeeded();

            const sourceBox = await sourceRow.boundingBox();
            const targetBox = await targetRow.boundingBox();

            // Drag source onto target to rebase
            if (sourceBox && targetBox) {
                // Move to source
                await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
                await page.mouse.down();
                // Move to target
                await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
                    steps: 10,
                });
                await page.mouse.up();
            }

            // Verify rebase via repo
            await expect(async () => {
                // Check 'source' parent is now 'target'
                const parents = repo.getParents(nodes.source.changeId);
                expect(parents).toContain(nodes.target.changeId);
            }).toPass({ timeout: 10000 });
        } finally {
            repo.dispose();
        }
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

        try {
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
        } finally {
            repo.dispose();
        }
    });
});
