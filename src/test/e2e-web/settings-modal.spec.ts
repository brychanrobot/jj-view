/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Settings Modal & Configuration System', () => {
    test('should open settings modal via gear button and close with Escape', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Settings modal should initially not be in DOM
        await expect(page.locator('[data-testid="settings-modal"]')).toHaveCount(0);

        // Click gear icon in SCM header
        const gearBtn = page.locator('[data-testid="scm-settings-button"]');
        await expect(gearBtn).toBeVisible();
        await gearBtn.click();

        // Modal should open
        const modal = page.locator('[data-testid="settings-modal"]');
        await expect(modal).toBeVisible();

        // Title and tabs
        await expect(modal.locator('#settings-title')).toHaveText('Settings');
        await expect(modal.locator('[data-testid="scope-tab-user"]')).toBeVisible();
        await expect(modal.locator('[data-testid="scope-tab-workspace"]')).toBeVisible();

        // Close with Escape key
        await page.keyboard.press('Escape');
        await expect(modal).toHaveCount(0);
    });

    test('should open settings modal via keyboard shortcut (Ctrl+,)', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Press Ctrl+,
        await page.keyboard.press('Control+,');
        const modal = page.locator('[data-testid="settings-modal"]');
        await expect(modal).toBeVisible();

        // Close via close button
        const closeBtn = page.locator('[data-testid="settings-close-btn"]');
        await closeBtn.click();
        await expect(modal).toHaveCount(0);
    });

    test('should filter settings by search and category, and capture screenshots', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Open settings
        await page.locator('[data-testid="scm-settings-button"]').click();
        const modal = page.locator('[data-testid="settings-modal"]');
        await expect(modal).toBeVisible();

        // Capture User Scope initial screenshot
        const userScreenshotPath = path.join(ARTIFACT_DIR, 'settings-modal-user.png');
        await modal.screenshot({ path: userScreenshotPath });

        // Search for "theme"
        const searchInput = page.locator('[data-testid="settings-search-input"]');
        await searchInput.fill('theme');

        // Theme setting should be displayed
        const themeRow = page.locator('[data-testid="setting-item-appearance.theme"]');
        await expect(themeRow).toBeVisible();
        await expect(themeRow.locator('.setting-title')).toHaveText('Color Theme');

        // Capture Search screenshot
        const searchScreenshotPath = path.join(ARTIFACT_DIR, 'settings-modal-search.png');
        await modal.screenshot({ path: searchScreenshotPath });

        // Switch to Workspace Tab
        const wsTab = page.locator('[data-testid="scope-tab-workspace"]');
        await wsTab.click();
        await expect(wsTab).toHaveClass(/active/);

        // Clear search
        await searchInput.fill('');

        // Capture Workspace Scope screenshot
        const wsScreenshotPath = path.join(ARTIFACT_DIR, 'settings-modal-workspace.png');
        await modal.screenshot({ path: wsScreenshotPath });

        // Select category "Appearance"
        const appearanceCatBtn = page.locator('[data-testid="category-btn-appearance"]');
        await appearanceCatBtn.click();
        await expect(appearanceCatBtn).toHaveClass(/active/);
        await expect(themeRow).toBeVisible();
    });

    test('should change appearance.theme and reactively switch whole-app skinning without diff header picker', async ({
        page,
        server,
        testRepo,
    }) => {
        // Create a sample changed file in test repo so diff viewer can be viewed
        testRepo.writeFile('welcome.ts', 'export function hello(): string {\n    return "Welcome to JJ View";\n}\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Open the changed file to display the diff viewer
        const fileItem = page.locator('[data-testid="scm-resource-item"]').filter({ hasText: 'welcome.ts' });
        await expect(fileItem).toBeVisible();
        await fileItem.click();

        // Verify diff viewer loaded
        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible();

        // Invariant check: diff toolbar MUST NOT contain any theme selector or dropdown
        const diffToolbar = page.locator('[data-testid="diff-toolbar"]');
        await expect(diffToolbar).toBeVisible();
        await expect(diffToolbar.locator('select')).toHaveCount(0);
        await expect(diffToolbar.locator('[data-testid*="theme"]')).toHaveCount(0);

        // Default theme should be dark
        const initialStatus = await page.evaluate(() => ({
            bodyClass: document.body.className,
            theme: document.documentElement.getAttribute('data-theme'),
            editorBg: getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim(),
        }));
        expect(initialStatus.bodyClass).toContain('vscode-dark');

        const gifPath = path.join(ARTIFACT_DIR, 'app-theming-flow.gif');
        const catppuccinPngPath = path.join(ARTIFACT_DIR, 'theme-catppuccin-mocha.png');
        const draculaPngPath = path.join(ARTIFACT_DIR, 'theme-dracula.png');
        const lightPngPath = path.join(ARTIFACT_DIR, 'theme-github-light.png');
        const pierreDarkPngPath = path.join(ARTIFACT_DIR, 'theme-pierre-dark-soft.png');

        await recordGifFlow(
            page,
            async (captureFrame) => {
                // Frame 1: Default Pierre Dark Soft state
                await page.screenshot({ path: pierreDarkPngPath });
                await captureFrame();

                // Frame 2: Open settings modal
                await page.locator('[data-testid="scm-settings-button"]').click();
                const modal = page.locator('[data-testid="settings-modal"]');
                await expect(modal).toBeVisible();
                await captureFrame();

                // Frame 3: Switch to Catppuccin Mocha
                const themeSelect = page.locator('[data-testid="setting-control-appearance.theme"]');
                await themeSelect.selectOption('catppuccin-mocha');

                await expect
                    .poll(async () => {
                        return await page.evaluate(() => ({
                            theme: document.documentElement.getAttribute('data-theme'),
                            editorBg: getComputedStyle(document.body)
                                .getPropertyValue('--vscode-editor-background')
                                .trim()
                                .toLowerCase(),
                        }));
                    })
                    .toEqual({
                        theme: 'catppuccin-mocha',
                        editorBg: '#1e1e2e',
                    });

                // Close settings modal to view full UI in Catppuccin Mocha
                await page.keyboard.press('Escape');
                await expect(modal).toHaveCount(0);
                await page.screenshot({ path: catppuccinPngPath });
                await captureFrame();

                // Frame 4: Use Command Palette (Color Theme) to switch to Dracula
                await page.keyboard.press('Control+Shift+P');
                const quickInput = page.locator('[data-testid="quick-input-widget"]');
                await expect(quickInput).toBeVisible();
                const paletteInput = page.locator('[data-testid="quick-input-text-input"]');
                await paletteInput.fill('Color Theme');
                await page.locator('[data-testid="quick-pick-item-workbench.action.selectTheme"]').click();

                // QuickPick with theme list is open
                await expect(page.locator('[data-testid="quick-input-title"]')).toHaveText('Select Color Theme');
                await paletteInput.fill('dracula');
                await page.locator('[data-testid="quick-pick-item-dracula"]').click();

                await expect
                    .poll(async () => {
                        return await page.evaluate(() => ({
                            theme: document.documentElement.getAttribute('data-theme'),
                            editorBg: getComputedStyle(document.body)
                                .getPropertyValue('--vscode-editor-background')
                                .trim()
                                .toLowerCase(),
                        }));
                    })
                    .toEqual({
                        theme: 'dracula',
                        editorBg: '#282a36',
                    });
                await page.screenshot({ path: draculaPngPath });
                await captureFrame();

                // Frame 5: Switch to GitHub Light
                await page.keyboard.press('Control+Shift+P');
                await expect(quickInput).toBeVisible();
                await paletteInput.fill('Color Theme');
                await page.locator('[data-testid="quick-pick-item-workbench.action.selectTheme"]').click();

                await expect(page.locator('[data-testid="quick-input-title"]')).toHaveText('Select Color Theme');
                await paletteInput.fill('github-light');
                await page.locator('[data-testid="quick-pick-item-github-light"]').click();

                await expect
                    .poll(async () => {
                        return await page.evaluate(() => ({
                            bodyClass: document.body.className,
                            theme: document.documentElement.getAttribute('data-theme'),
                            editorBg: getComputedStyle(document.body)
                                .getPropertyValue('--vscode-editor-background')
                                .trim()
                                .toLowerCase(),
                        }));
                    })
                    .toEqual({
                        bodyClass: expect.stringContaining('vscode-light'),
                        theme: 'github-light',
                        editorBg: '#fff',
                    });
                await page.screenshot({ path: lightPngPath });
                await captureFrame();

                // Frame 6: Switch back to Pierre Dark Soft
                await page.keyboard.press('Control+Shift+P');
                await expect(quickInput).toBeVisible();
                await paletteInput.fill('Color Theme');
                await page.locator('[data-testid="quick-pick-item-workbench.action.selectTheme"]').click();

                await expect(page.locator('[data-testid="quick-input-title"]')).toHaveText('Select Color Theme');
                await paletteInput.fill('pierre-dark-soft');
                await page.locator('[data-testid="quick-pick-item-pierre-dark-soft"]').click();

                await expect
                    .poll(async () => {
                        return await page.evaluate(() => ({
                            bodyClass: document.body.className,
                            theme: document.documentElement.getAttribute('data-theme'),
                            editorBg: getComputedStyle(document.body)
                                .getPropertyValue('--vscode-editor-background')
                                .trim()
                                .toLowerCase(),
                        }));
                    })
                    .toEqual({
                        bodyClass: expect.stringContaining('vscode-dark'),
                        theme: 'pierre-dark-soft',
                        editorBg: '#171717',
                    });
                await captureFrame();
            },
            {
                outputPath: gifPath,
                framerate: 1,
            },
        );
    });

    test('should reactively reload settings when .vscode/settings.json is modified on disk', async ({
        page,
        server,
        testRepo,
    }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Open settings modal and go to Workspace tab
        await page.locator('[data-testid="scm-settings-button"]').click();
        const modal = page.locator('[data-testid="settings-modal"]');
        await expect(modal).toBeVisible();
        await page.locator('[data-testid="scope-tab-workspace"]').click();

        // Write to .vscode/settings.json on disk
        const vscodeDir = path.join(testRepo.path, '.vscode');
        if (!fs.existsSync(vscodeDir)) {
            fs.mkdirSync(vscodeDir, { recursive: true });
            await page.waitForTimeout(300);
        }
        const settingsPath = path.join(vscodeDir, 'settings.json');
        fs.writeFileSync(
            settingsPath,
            JSON.stringify({
                'jj-view.fileWatcherMode': 'watch',
            }),
            'utf-8',
        );

        // The input in workspace tab should update
        const watcherSelect = page.locator('[data-testid="setting-control-fileWatcherMode"]');
        await expect(watcherSelect).toHaveValue('watch', { timeout: 10000 });
    });

    test('should properly theme and toggle checkbox controls', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Open settings modal
        await page.locator('[data-testid="scm-settings-button"]').click();
        const modal = page.locator('[data-testid="settings-modal"]');
        await expect(modal).toBeVisible();

        // Find checkbox for showProcessMonitorPanel
        const checkbox = page.locator('[data-testid="setting-control-showProcessMonitorPanel"]');
        await expect(checkbox).toBeVisible();
        await expect(checkbox).not.toBeChecked();

        // Label should say Disabled
        const toggleItem = page.locator('[data-testid="setting-item-showProcessMonitorPanel"]');
        await expect(toggleItem.locator('.toggle-label')).toHaveText('Disabled');

        // Toggle checkbox on
        await checkbox.click();
        await expect(checkbox).toBeChecked();
        await expect(toggleItem.locator('.toggle-label')).toHaveText('Enabled');

        // Capture checked checkbox screenshot
        const checkedScreenshotPath = path.join(ARTIFACT_DIR, 'settings-modal-checkbox-checked.png');
        await modal.screenshot({ path: checkedScreenshotPath });

        // Toggle back off
        await checkbox.click();
        await expect(checkbox).not.toBeChecked();
        await expect(toggleItem.locator('.toggle-label')).toHaveText('Disabled');
    });

    test('should dynamically preview themes on navigation, revert on escape, and display clean items', async ({
        page,
        server,
    }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Open Color Theme quick pick via command palette
        await page.keyboard.press('Control+Shift+P');
        const quickInput = page.locator('[data-testid="quick-input-widget"]');
        await expect(quickInput).toBeVisible();
        const input = page.locator('[data-testid="quick-input-text-input"]');
        await input.fill('Color Theme');
        await page.locator('[data-testid="quick-pick-item-workbench.action.selectTheme"]').click();

        // Theme picker is open
        await expect(page.locator('[data-testid="quick-input-title"]')).toHaveText('Select Color Theme');

        // Checkmark should be on pierre-dark-soft (initial theme)
        const initialItem = page.locator('[data-testid="quick-pick-item-pierre-dark-soft"]');
        await expect(initialItem.locator('.codicon-check')).toBeVisible();

        // No item should have codicon-chevron-right (">")
        await expect(page.locator('.quick-pick-item .codicon-chevron-right')).toHaveCount(0);

        // Filter for dracula
        await input.fill('dracula');
        const draculaItem = page.locator('[data-testid="quick-pick-item-dracula"]');
        await expect(draculaItem).toBeVisible();

        // Dracula item should be active and previewed
        await expect
            .poll(async () => {
                return await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
            })
            .toBe('dracula');

        // Cancel with Escape
        await page.keyboard.press('Escape');
        await expect(quickInput).toHaveCount(0);

        // Theme should revert back to pierre-dark-soft
        await expect
            .poll(async () => {
                return await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
            })
            .toBe('pierre-dark-soft');
    });
});
