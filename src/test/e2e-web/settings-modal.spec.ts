/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, test, waitForScmReady } from './standalone-fixture';

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

    test('should change appearance.theme and reactively switch body class and theme attribute', async ({
        page,
        server,
    }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Default should be dark theme
        const bodyClass = await page.evaluate(() => document.body.className);
        expect(bodyClass).toContain('vscode-dark');

        // Open settings modal
        await page.locator('[data-testid="scm-settings-button"]').click();
        const modal = page.locator('[data-testid="settings-modal"]');
        await expect(modal).toBeVisible();

        // Locate theme select
        const themeSelect = page.locator('[data-testid="setting-control-appearance.theme"]');
        await expect(themeSelect).toBeVisible();

        // Switch to Pierre Light Soft
        await themeSelect.selectOption('pierre-light-soft');

        // Verify body class changed to light and data-theme changed
        await expect
            .poll(async () => {
                return await page.evaluate(() => ({
                    bodyClass: document.body.className,
                    theme: document.documentElement.getAttribute('data-theme'),
                }));
            })
            .toEqual({
                bodyClass: expect.stringContaining('vscode-light'),
                theme: 'pierre-light-soft',
            });

        // Capture Light Theme screenshot
        const lightScreenshotPath = path.join(ARTIFACT_DIR, 'settings-modal-light.png');
        await modal.screenshot({ path: lightScreenshotPath });

        // Switch back to Pierre Dark Soft
        await themeSelect.selectOption('pierre-dark-soft');
        await expect
            .poll(async () => {
                return await page.evaluate(() => ({
                    bodyClass: document.body.className,
                    theme: document.documentElement.getAttribute('data-theme'),
                }));
            })
            .toEqual({
                bodyClass: expect.stringContaining('vscode-dark'),
                theme: 'pierre-dark-soft',
            });
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
});
