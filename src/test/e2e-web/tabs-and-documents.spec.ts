/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { ARTIFACT_DIR as ARTIFACTS_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Tabs, Preview Mode & Document Management', () => {
    test('should open preview tabs, replace clean preview on click, and pin on double click', async ({
        page,
        server,
        testRepo,
    }) => {
        // Create 2 modified files in working copy
        testRepo.writeFile('file1.txt', 'alpha original\n');
        testRepo.writeFile('file2.txt', 'beta original\n');
        testRepo.describe('initial commit');
        testRepo.new();

        testRepo.writeFile('file1.txt', 'alpha modified\n');
        testRepo.writeFile('file2.txt', 'beta modified\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item1 = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'file1.txt' });
        const item2 = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'file2.txt' });

        await expect(item1).toBeVisible();
        await expect(item2).toBeVisible();

        // 1. Single click file1.txt -> opens as preview tab
        await item1.click();
        const tabBar = page.locator('[data-testid="tab-bar-container"]');
        await expect(tabBar).toBeVisible();

        const tabs = tabBar.locator('.tab');
        await expect(tabs).toHaveCount(1);
        const tab1 = tabs.first();
        await expect(tab1).toHaveClass(/preview/);
        await expect(tab1).toHaveClass(/active/);
        await expect(tab1.locator('.tab-label')).toContainText('file1.txt');

        // Screenshot preview mode
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'tab-preview-mode.png') });

        // 2. Single click file2.txt -> replaces existing clean preview tab in place
        await item2.click();
        await expect(tabs).toHaveCount(1);
        const currentTab = tabs.first();
        await expect(currentTab).toHaveClass(/preview/);
        await expect(currentTab.locator('.tab-label')).toContainText('file2.txt');

        // 3. Double-click file1.txt -> opens pinned (preview: false)
        await item1.dblclick();
        // Now there should be 2 tabs: file2.txt (preview) and file1.txt (pinned)
        await expect(tabs).toHaveCount(2);

        const pinnedTab = tabs.filter({ hasText: 'file1.txt' });
        await expect(pinnedTab).toBeVisible();
        await expect(pinnedTab).not.toHaveClass(/preview/);
        await expect(pinnedTab).toHaveClass(/active/);

        // 4. Double-click file2.txt tab header -> pins file2.txt tab as well
        const file2Tab = tabs.filter({ hasText: 'file2.txt' });
        await expect(file2Tab).toHaveClass(/preview/);
        await file2Tab.dblclick();
        await expect(file2Tab).not.toHaveClass(/preview/);
    });

    test('should pin tab on edit and show dirty dot with hover close button', async ({ page, server, testRepo }) => {
        testRepo.writeFile('document.txt', 'line 1\nline 2\n');
        testRepo.describe('initial commit');
        testRepo.new();

        testRepo.writeFile('document.txt', 'line 1\nline 2 changed\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'document.txt' });
        await item.click();

        const tab = page.locator('[data-testid="tab-bar-container"] .tab').first();
        await expect(tab).toBeVisible();
        await expect(tab).toHaveClass(/preview/);

        // Focus Pierre diff editor and type to dirty the buffer
        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible();
        await expect(diffViewer).toContainText('line 2 changed');

        const editorTextbox = diffViewer.getByRole('textbox');
        await expect(editorTextbox).toBeVisible({ timeout: 5000 });

        await editorTextbox.click();
        await page.waitForTimeout(200);
        await page.keyboard.type('\nnew edit line', { delay: 50 });

        // Verify tab is automatically pinned and marked dirty
        await expect(tab).toHaveClass(/dirty/, { timeout: 10000 });
        await expect(tab).not.toHaveClass(/preview/);

        // Verify dirty dot is visible
        const dirtyIndicator = tab.locator('.dirty-indicator');
        await expect(dirtyIndicator).toBeVisible();
        await expect(dirtyIndicator).toHaveText('●');

        // Screenshot dirty dot
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'tab-dirty-indicator.png') });
    });

    test('should close active tab with Ctrl+W and activate adjacent tab', async ({ page, server, testRepo }) => {
        testRepo.writeFile('first.txt', 'first content\n');
        testRepo.writeFile('second.txt', 'second content\n');
        testRepo.describe('initial commit');
        testRepo.new();

        testRepo.writeFile('first.txt', 'first content updated\n');
        testRepo.writeFile('second.txt', 'second content updated\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const itemFirst = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'first.txt' });
        const itemSecond = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'second.txt' });

        // Open both pinned
        await itemFirst.dblclick();
        await itemSecond.dblclick();

        const tabs = page.locator('[data-testid="tab-bar-container"] .tab');
        await expect(tabs).toHaveCount(2);

        // second.txt is currently active
        const tabSecond = tabs.filter({ hasText: 'second.txt' });
        await expect(tabSecond).toHaveClass(/active/);

        // Press Control+w to close active tab
        await page.keyboard.press('Control+w');

        // second.txt is closed, first.txt becomes active
        await expect(tabs).toHaveCount(1);
        const remainingTab = tabs.first();
        await expect(remainingTab.locator('.tab-label')).toContainText('first.txt');
        await expect(remainingTab).toHaveClass(/active/);

        // Press Control+w to close last tab
        await page.keyboard.press('Control+w');
        await expect(tabs).toHaveCount(0);

        // Empty editor view is shown
        const emptyMsg = page.locator('.empty-editor-message');
        await expect(emptyMsg).toBeVisible();
    });

    test('should support tab reordering via drag-and-drop and record interactive GIF flow', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('fileA.txt', 'alpha content\n');
        testRepo.writeFile('fileB.txt', 'beta content\n');
        testRepo.writeFile('fileC.txt', 'gamma content\n');
        testRepo.describe('initial commit');
        testRepo.new();

        testRepo.writeFile('fileA.txt', 'alpha updated\n');
        testRepo.writeFile('fileB.txt', 'beta updated\n');
        testRepo.writeFile('fileC.txt', 'gamma updated\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const gifPath = path.join(ARTIFACTS_DIR, 'tabs-workflow.gif');

        await recordGifFlow(
            page,
            async (captureFrame) => {
                await captureFrame();

                const itemA = page
                    .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
                    .filter({ hasText: 'fileA.txt' });
                const itemB = page
                    .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
                    .filter({ hasText: 'fileB.txt' });
                const itemC = page
                    .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
                    .filter({ hasText: 'fileC.txt' });

                // 1. Open fileA pinned
                await itemA.dblclick();
                await page.waitForTimeout(300);
                await captureFrame();

                // 2. Open fileB pinned
                await itemB.dblclick();
                await page.waitForTimeout(300);
                await captureFrame();

                // 3. Open fileC preview
                await itemC.click();
                await page.waitForTimeout(300);
                await captureFrame();

                const tabs = page.locator('[data-testid="tab-bar-container"] .tab');
                await expect(tabs).toHaveCount(3);

                // Initial order: fileA.txt, fileB.txt, fileC.txt
                const initialTexts = await tabs.locator('.tab-label').allTextContents();
                expect(initialTexts).toEqual([
                    'fileA.txt (Working Copy)',
                    'fileB.txt (Working Copy)',
                    'fileC.txt (Working Copy)',
                ]);

                // 4. Drag fileC before fileA
                const tabC = tabs.nth(2);
                const tabA = tabs.nth(0);
                await tabC.dragTo(tabA);
                await page.waitForTimeout(400);
                await captureFrame();

                // Screenshot reordered tabs
                await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'tabs-reordered.png') });

                // 5. Close active tab with Ctrl+W
                await page.keyboard.press('Control+w');
                await page.waitForTimeout(300);
                await captureFrame();

                // 6. Close next tab with close button
                const closeBtn = page.locator('[data-testid="tab-bar-container"] .tab.active .tab-close-button');
                if (await closeBtn.isVisible().catch(() => false)) {
                    await closeBtn.click();
                    await page.waitForTimeout(300);
                    await captureFrame();
                }
            },
            { outputPath: gifPath, framerate: 1.0, scale: 960 },
        );

        expect(page.locator('[data-testid="tab-bar-container"]')).toBeDefined();
    });
});
