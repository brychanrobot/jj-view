/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { TestRepo } from '../test-repo';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Context Menus and Actions', () => {
    test('should create a new revision when clicking the New header button', async ({ page, server, testRepo }) => {
        testRepo.writeFile('base.txt', 'base content\n');
        testRepo.describe('first commit');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Click the "New" button in the SCM header
        const newBtn = page.locator('[data-testid="scm-title-action-jj-view.new"]');
        await expect(newBtn).toBeVisible();
        await newBtn.click();

        // Verify a new working copy is created whose parent is 'first commit'
        await expect
            .poll(
                () => {
                    const parent = testRepo.getDescription('@-');
                    return parent;
                },
                { timeout: 10000 },
            )
            .toContain('first commit');
    });

    test('should refresh SCM state when clicking the Refresh header button', async ({ page, server, testRepo }) => {
        testRepo.writeFile('file.txt', 'initial\n');
        testRepo.describe('initial commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const wcItems = page.locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]');
        await expect(wcItems).toHaveCount(0);

        // Modify file on disk
        testRepo.writeFile('file.txt', 'modified content\n');

        // Click the SCM header Refresh button
        const refreshBtn = page.locator('[data-testid="scm-title-action-jj-view.refresh"]');
        await expect(refreshBtn).toBeVisible();
        await refreshBtn.click();

        // Verify modified file is detected
        await expect(wcItems).toHaveCount(1, { timeout: 10000 });
        await expect(wcItems).toContainText('file.txt');
    });

    test('should open context menu on right-click and restore file via context menu action', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('revert-me.txt', 'original content\n');
        testRepo.describe('initial commit');
        testRepo.new();

        testRepo.writeFile('revert-me.txt', 'unwanted edit\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'revert-me.txt' });
        await expect(item).toBeVisible();

        // Right-click on the resource item
        await item.click({ button: 'right' });

        // Verify context menu appears
        const contextMenu = page.locator('[data-testid="context-menu"]');
        await expect(contextMenu).toBeVisible();

        // Verify restore menu item exists and click it
        const restoreMenuItem = page.locator('[data-testid="menu-item-jj-view.restore"]');
        await expect(restoreMenuItem).toBeVisible();
        await restoreMenuItem.click();

        // Verify context menu closes and working copy is restored
        await expect(contextMenu).not.toBeVisible();
        const wcItems = page.locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]');
        await expect(wcItems).toHaveCount(0, { timeout: 10000 });

        const diskContent = testRepo.getFileContent('@', 'revert-me.txt');
        expect(diskContent).toBe('original content\n');
    });

    test('should dismiss context menu when pressing Escape', async ({ page, server, testRepo }) => {
        testRepo.writeFile('test.txt', 'test\n');
        testRepo.describe('initial commit');
        testRepo.new();
        testRepo.writeFile('test.txt', 'test edit\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'test.txt' });
        await expect(item).toBeVisible();

        // Right-click to open context menu
        await item.click({ button: 'right' });
        const contextMenu = page.locator('[data-testid="context-menu"]');
        await expect(contextMenu).toBeVisible();

        // Press Escape to dismiss
        await page.keyboard.press('Escape');
        await expect(contextMenu).not.toBeVisible();
    });

    test('should open context menu on right-click in log webview and execute New After', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('initial.txt', 'v1\n');
        testRepo.describe('initial commit');
        testRepo.new();
        testRepo.writeFile('feature.txt', 'v2\n');
        testRepo.describe('feature commit');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Find the feature commit row in the Log pane
        const commitRow = page.locator('.commit-row').filter({ hasText: 'feature commit' }).first();
        await expect(commitRow).toBeVisible({ timeout: 10000 });

        // Right-click on the commit row
        await commitRow.click({ button: 'right' });

        const contextMenu = page.locator('[data-testid="context-menu"]');
        await expect(contextMenu).toBeVisible();

        // Capture screenshot of the generalized context menu
        await page.screenshot({
            path: path.join(ARTIFACT_DIR, 'log-context-menu.png'),
        });

        // Verify webview context menu items are present
        const newAfterItem = page.locator('[data-testid="menu-item-jj-view.newAfter"]');
        await expect(newAfterItem).toBeVisible();

        const diffItem = page.locator('[data-testid="menu-item-jj-view.showMultiFileDiff"]');
        await expect(diffItem).toBeVisible();

        // Click "New After"
        await newAfterItem.click();

        // Context menu should dismiss
        await expect(contextMenu).not.toBeVisible();

        // Verify a new working copy revision was created whose parent contains 'feature commit'
        await expect
            .poll(
                () => {
                    return testRepo.getDescription('@-');
                },
                { timeout: 10000 },
            )
            .toContain('feature commit');
    });

    test('should open tab context menu and execute Close Others', async ({ page, server, testRepo }) => {
        testRepo.writeFile('file1.txt', 'content 1\n');
        testRepo.writeFile('file2.txt', 'content 2\n');
        testRepo.writeFile('file3.txt', 'content 3\n');
        testRepo.describe('initial commit');
        testRepo.new();

        testRepo.writeFile('file1.txt', 'edit 1\n');
        testRepo.writeFile('file2.txt', 'edit 2\n');
        testRepo.writeFile('file3.txt', 'edit 3\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item1 = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'file1.txt' });
        const item2 = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'file2.txt' });
        const item3 = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'file3.txt' });

        await expect(item1).toBeVisible();
        await expect(item2).toBeVisible();
        await expect(item3).toBeVisible();

        // Double click to open all 3 as pinned tabs
        await item1.dblclick();
        await item2.dblclick();
        await item3.dblclick();

        const tabBar = page.locator('[data-testid="tab-bar-container"]');
        await expect(tabBar).toBeVisible();
        const tabs = tabBar.locator('.tab');
        await expect(tabs).toHaveCount(3);

        // Find file2.txt tab and right click it
        const tab2 = tabs.filter({ hasText: 'file2.txt' });
        await expect(tab2).toBeVisible();
        await tab2.click({ button: 'right' });

        // Verify context menu appears with editor/title/context actions
        const contextMenu = page.locator('[data-testid="context-menu"]');
        await expect(contextMenu).toBeVisible();
        await expect(page.locator('[data-testid="menu-item-workbench.action.closeActiveEditor"]')).toBeVisible();
        await expect(page.locator('[data-testid="menu-item-workbench.action.closeOtherEditors"]')).toBeVisible();
        await expect(page.locator('[data-testid="menu-item-workbench.action.closeEditorsToTheRight"]')).toBeVisible();
        await expect(page.locator('[data-testid="menu-item-workbench.action.closeAllEditors"]')).toBeVisible();
        await expect(page.locator('[data-testid="menu-item-jj-view.compareFileWith"]')).toBeVisible();
        await expect(page.locator('[data-testid="menu-item-jj-view.restoreFileFrom"]')).toBeVisible();

        // Capture screenshot of tab context menu
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'tab-context-menu.png') });

        // Click "Close Others"
        await page.locator('[data-testid="menu-item-workbench.action.closeOtherEditors"]').click();
        await expect(contextMenu).not.toBeVisible();

        // Verify only file2.txt tab remains
        await expect(tabs).toHaveCount(1);
        await expect(tabs.first()).toContainText('file2.txt');
    });

    test('should open diff editor context menu on right click in diff viewer', async ({ page, server, testRepo }) => {
        testRepo.writeFile('diff-target.txt', 'original line 1\noriginal line 2\n');
        testRepo.describe('initial commit');
        testRepo.new();

        testRepo.writeFile('diff-target.txt', 'modified line 1\nmodified line 2\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'diff-target.txt' });
        await expect(item).toBeVisible();
        await item.click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible();

        // Right-click inside diff content container
        const diffContainer = page.locator('[data-testid="diff-content-container"]');
        await expect(diffContainer).toBeVisible();
        await diffContainer.click({ button: 'right' });

        // Verify context menu appears with editor/context actions
        const contextMenu = page.locator('[data-testid="context-menu"]');
        await expect(contextMenu).toBeVisible();
        await expect(page.locator('[data-testid="menu-item-jj-view.compareFileWith"]')).toBeVisible();
        await expect(page.locator('[data-testid="menu-item-jj-view.viewFileAtRevision"]')).toBeVisible();
        await expect(page.locator('[data-testid="menu-item-jj-view.restoreFileFrom"]')).toBeVisible();

        // Capture screenshot of diff editor context menu
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'diff-editor-context-menu.png') });

        // Press Escape to dismiss
        await page.keyboard.press('Escape');
        await expect(contextMenu).not.toBeVisible();
    });

    test('should sync repository when clicking the Sync button in the JJ Log title bar', async ({
        page,
        server,
        testRepo,
    }) => {
        const remoteRepo = new TestRepo();
        remoteRepo.init();
        try {
            remoteRepo.writeFile('remote.txt', 'from remote\n');
            remoteRepo.describe('feat: upstream remote commit');
            remoteRepo.bookmark('main', '@');

            testRepo.addRemote('origin', remoteRepo.path);
            testRepo.writeFile('local.txt', 'local change\n');
            testRepo.describe('feat: local work');

            await page.goto(server.serverUrl);
            await waitForScmReady(page);

            const syncBtn = page.locator('[data-testid="log-title-action-jj-view.sync"]');
            await expect(syncBtn).toBeVisible();
            await expect(syncBtn).toHaveAttribute('title', 'Sync');

            const logContent = page.locator('[data-testid="log-content"]');
            await expect(logContent.getByText('feat: local work')).toBeVisible();
            await expect(logContent.getByText('feat: upstream remote commit')).toHaveCount(0);

            await recordGifFlow(
                page,
                async (capture) => {
                    await capture();
                    await syncBtn.click();
                    await expect(logContent.getByText('feat: upstream remote commit')).toBeVisible({
                        timeout: 10000,
                    });
                    await capture();
                },
                { outputPath: path.join(ARTIFACT_DIR, 'log-sync-flow.gif') },
            );

            expect(testRepo.getLog('main@origin', 'description')).toContain('feat: upstream remote commit');
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'log-sync-button.png') });
        } finally {
            await remoteRepo.dispose();
        }
    });
    test('should show Simplify Parents on merge commit context menu and remove redundant parent', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('base.txt', 'base\n');
        testRepo.describe('base C');
        const cId = testRepo.getChangeId('@');

        testRepo.new([cId], 'child B');
        const bId = testRepo.getChangeId('@');
        testRepo.writeFile('b.txt', 'b\n');

        testRepo.new([bId, cId], 'merge A');
        const aId = testRepo.getChangeId('@');
        expect(testRepo.getParents(aId)).toEqual([bId, cId]);

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const contextMenu = page.locator('[data-testid="context-menu"]');
        const simplifyItem = page.locator('[data-testid="menu-item-jj-view.simplifyParents"]');

        // Single-parent commit B should not expose Simplify Parents in context menu
        const commitRowB = page.locator('.commit-row').filter({ hasText: 'child B' }).first();
        await expect(commitRowB).toBeVisible({ timeout: 10000 });
        await commitRowB.click({ button: 'right' });
        await expect(contextMenu).toBeVisible();
        await expect(simplifyItem).toHaveCount(0);

        await page.keyboard.press('Escape');
        await expect(contextMenu).not.toBeVisible();

        // Merge commit A should expose Simplify Parents and remove redundant parent C
        const commitRowA = page.locator('.commit-row').filter({ hasText: 'merge A' }).first();
        await expect(commitRowA).toBeVisible();
        await commitRowA.click({ button: 'right' });
        await expect(contextMenu).toBeVisible();
        await expect(simplifyItem).toBeVisible();

        await simplifyItem.click();
        await expect(contextMenu).not.toBeVisible();

        await expect.poll(() => testRepo.getParents(aId), { timeout: 10000 }).toEqual([bId]);
    });

    test('should restore file from selected revision via tab context menu', async ({ page, server, testRepo }) => {
        testRepo.writeFile('restore-target.txt', 'v1 original\n');
        testRepo.describe('base revision');
        testRepo.new();

        testRepo.writeFile('restore-target.txt', 'v2 middle\n');
        testRepo.describe('middle revision');
        testRepo.new();

        testRepo.writeFile('restore-target.txt', 'v3 working copy\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'restore-target.txt' });
        await expect(item).toBeVisible();
        await item.click();

        const tab = page
            .locator('[data-testid="tab-bar-container"] .tab')
            .filter({ hasText: 'restore-target.txt' })
            .first();
        await expect(tab).toBeVisible();
        await tab.click({ button: 'right' });

        const restoreFromItem = page.locator('[data-testid="menu-item-jj-view.restoreFileFrom"]');
        await expect(restoreFromItem).toBeVisible();
        await restoreFromItem.click();

        const quickInput = page.locator('[data-testid="quick-input-widget"]');
        await expect(quickInput).toBeVisible();
        const baseOption = quickInput.locator('.quick-pick-item').filter({ hasText: 'base revision' }).first();
        await expect(baseOption).toBeVisible();
        await baseOption.click();

        await expect(quickInput).toHaveCount(0);
        await expect.poll(() => testRepo.readFile('restore-target.txt'), { timeout: 10000 }).toBe('v1 original\n');
    });

    test('should flush dirty buffer, restore from revision, and not clobber with stale auto-save', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('dirty-restore.txt', 'v1 baseline\n');
        testRepo.describe('base revision');
        testRepo.new();

        testRepo.writeFile('dirty-restore.txt', 'v2 middle\n');
        testRepo.describe('middle revision');
        testRepo.new();

        testRepo.writeFile('dirty-restore.txt', 'v3 working copy\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'dirty-restore.txt' });
        await expect(item).toBeVisible();
        await item.click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible();
        const editorTextbox = diffViewer.getByRole('textbox');
        await expect(editorTextbox).toBeVisible({ timeout: 5000 });
        const editableLine = editorTextbox.locator('[data-line]').last();
        await expect(async () => {
            await editableLine.click();
            await expect(editorTextbox).toBeFocused({ timeout: 500 });
            await expect(editableLine).toHaveAttribute('data-editor-active-line', '', { timeout: 500 });
        }).toPass({ timeout: 10000 });
        await editorTextbox.pressSequentially(' unsaved edit', { delay: 15 });

        const tab = page
            .locator('[data-testid="tab-bar-container"] .tab')
            .filter({ hasText: 'dirty-restore.txt' })
            .first();
        await expect(tab).toHaveClass(/dirty/, { timeout: 5000 });

        await tab.click({ button: 'right' });
        const restoreFromItem = page.locator('[data-testid="menu-item-jj-view.restoreFileFrom"]');
        await expect(restoreFromItem).toBeVisible();
        await restoreFromItem.click();

        const quickInput = page.locator('[data-testid="quick-input-widget"]');
        await expect(quickInput).toBeVisible();
        const baseOption = quickInput.locator('.quick-pick-item').filter({ hasText: 'base revision' }).first();
        await expect(baseOption).toBeVisible();
        await baseOption.click();

        await expect(quickInput).toHaveCount(0);
        await expect.poll(() => testRepo.readFile('dirty-restore.txt'), { timeout: 10000 }).toBe('v1 baseline\n');
        await expect(tab).not.toHaveClass(/dirty/, { timeout: 5000 });
        await expect(diffViewer).toContainText('v1 baseline', { timeout: 5000 });
        await expect(diffViewer).not.toContainText('unsaved edit');
    });
});
