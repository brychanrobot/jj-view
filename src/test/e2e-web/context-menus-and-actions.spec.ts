/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { ARTIFACT_DIR, expect, test, waitForScmReady } from './standalone-fixture';

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
});
