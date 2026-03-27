/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import { TestRepo, buildGraph } from '../test-repo';
import { ROOT_ID, entry, expectTree, focusJJLog, getLogWebview, launchVSCode } from './e2e-helpers';

test.describe('JJ Log Pane E2E', () => {
    test('Webview Initialization & Rendering', async () => {
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
                isWorkingCopy: true,
                bookmarks: ['main'],
            },
        ]);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusJJLog(page);
            const webview = await getLogWebview(page);

            // Assert all commit descriptions are present
            await expect(webview.locator('.commit-desc', { hasText: 'initial setup' })).toBeVisible();
            await expect(webview.locator('.commit-desc', { hasText: 'side branch commit' })).toBeVisible();
            await expect(webview.locator('.commit-desc', { hasText: 'working tree' })).toBeVisible();

            // Assert Working Copy row is styled bold
            const wcDesc = webview.locator('.working-copy .commit-desc');
            await expect(wcDesc).toHaveCSS('font-weight', '700' /* bold */);

            // Assert Bookmark pill is present inside the working copy row
            const bookmarkPill = webview.locator('.working-copy .bookmark-pill', { hasText: 'main' });
            await expect(bookmarkPill).toBeVisible();
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('Pane Header Actions: Undo and New Merge Change', async () => {
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
                isWorkingCopy: true,
            },
        ]);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusJJLog(page);
            const webview = await getLogWebview(page);
            // 1. New Merge Change (Requires Multi-select)
            const sideBranchRow = webview.locator(`[data-change-id="${nodes['side_branch'].changeId}"]`);
            const wcRow = webview.locator(`[data-change-id="${nodes['wc'].changeId}"]`);

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
                expect(parents).toContain(nodes['side_branch'].changeId);
                expect(parents).toContain(nodes['wc'].changeId);
            }).toPass({ timeout: 5000 });

            // Verify full tree: [merge, wc, side_branch, initial, dummy]
            await expect(async () => {
                const mergeChangeId = repo.getChangeId('@');
                await expectTree(repo, [
                    '@ ' + entry(mergeChangeId, '(empty)', [nodes['side_branch'].changeId, nodes['wc'].changeId]),
                    entry(nodes['wc'].changeId, 'working tree', nodes['initial'].changeId),
                    entry(nodes['side_branch'].changeId, 'side branch', nodes['initial'].changeId),
                    entry(nodes['initial'].changeId, 'initial setup', dummyId),
                    entry(dummyId, '(empty)', ROOT_ID),
                ]);
            }).toPass();

            // 2. Undo
            const undoAction = page.getByRole('button', { name: 'Undo' }).first();
            await undoAction.click();

            // Assert the merge change was undone accurately
            await expectTree(repo, [
                '@ ' + entry(nodes['wc'].changeId, 'working tree', nodes['initial'].changeId),
                entry(nodes['side_branch'].changeId, 'side branch', nodes['initial'].changeId),
                entry(nodes['initial'].changeId, 'initial setup', dummyId),
                entry(dummyId, '(empty)', ROOT_ID),
            ]);
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('Hover Actions: New Child, Squash, Abandon', async () => {
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
                isWorkingCopy: true,
            },
        ]);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusJJLog(page);
            const webview = await getLogWebview(page);

            // 1. New Child
            const branchId = nodes['branch'].changeId;
            const branchRow = webview.locator(`[data-change-id="${branchId}"]`);
            await branchRow.hover();
            await expect(branchRow).toHaveAttribute('data-hovered', 'true');

            const newChildBtn = branchRow.locator('[title="New Child"]');
            await newChildBtn.click();

            let childId = '';
            await expect(async () => {
                const currentId = repo.getChangeId('@');
                // Ensure @ has actually moved away from wc
                expect(currentId).not.toBe(nodes['wc'].changeId);
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
                    '@ ' + entry(childId, '(empty)', nodes['branch'].changeId),
                    entry(nodes['wc'].changeId, 'working tree', nodes['branch'].changeId),
                    entry(nodes['branch'].changeId, 'branch commit', nodes['initial'].changeId),
                    entry(nodes['initial'].changeId, 'initial setup', dummyId),
                    entry(dummyId, '(empty)', ROOT_ID),
                ]);
            }).toPass();

            // 2. Prepare for squash: move working copy away from the new child
            const initialId = nodes['initial'].changeId;
            const initialRow = webview.locator(`[data-change-id="${initialId}"]`);
            await initialRow.hover();

            const editBtn = initialRow.locator('[title="Edit Commit"]');
            await editBtn.click();

            // Tree is the same commits, just @ moved. Order: [child, wc, branch, initial, dummy]
            await expectTree(repo, [
                entry(childId, '(empty)', nodes['branch'].changeId),
                entry(nodes['wc'].changeId, 'working tree', nodes['branch'].changeId),
                entry(nodes['branch'].changeId, 'branch commit', nodes['initial'].changeId),
                '@ ' + entry(nodes['initial'].changeId, 'initial setup', dummyId),
                entry(dummyId, '(empty)', ROOT_ID),
            ]);

            // 3. Squash the child into branch
            const childRow = webview.locator(`[data-change-id="${childId}"]`);
            await expect(childRow).toBeVisible({ timeout: 10000 });
            await childRow.hover();
            await expect(childRow).toHaveAttribute('data-hovered', 'true');
            const squashBtn = childRow.locator('[title="Squash into Parent"]');
            await squashBtn.click();

            // After squash: child is gone. branch has its changes.
            await expectTree(repo, [
                entry(nodes['wc'].changeId, 'working tree', nodes['branch'].changeId),
                entry(nodes['branch'].changeId, 'branch commit', nodes['initial'].changeId),
                '@ ' + entry(nodes['initial'].changeId, 'initial setup', dummyId),
                entry(dummyId, '(empty)', ROOT_ID),
            ]);

            // 4. Abandon the branch commit
            const branchRowAfter = webview.locator(`[data-change-id="${branchId}"]`);
            await branchRowAfter.hover();
            const abandonBtn = branchRowAfter.locator('[title="Abandon Commit"]');
            await abandonBtn.click();

            // After abandon branch: branch is gone. wc (child of branch) becomes child of initial.
            // Tree: [wc, initial(@)]
            await expectTree(repo, [
                entry(nodes['wc'].changeId, 'working tree', nodes['initial'].changeId),
                '@ ' + entry(nodes['initial'].changeId, 'initial setup', dummyId),
                entry(dummyId, '(empty)', ROOT_ID),
            ]);
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('Multi-select and Drag & Drop (Rebase)', async () => {
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

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusJJLog(page);
            const webview = await getLogWebview(page);

            const sourceRow = webview.locator(`[data-change-id="${nodes['source'].changeId}"]`);
            const targetRow = webview.locator(`[data-change-id="${nodes['target'].changeId}"]`);

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
                const parents = repo.getParents(nodes['source'].changeId);
                expect(parents).toContain(nodes['target'].changeId);
            }).toPass({ timeout: 10000 });
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });
});
