/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Quick Input & Command Palette', () => {
    test('should open command palette via keyboard shortcuts and close with Escape', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Command palette should initially not be visible
        await expect(page.locator('[data-testid="quick-input-widget"]')).toHaveCount(0);

        // Trigger Command Palette with Control+Shift+P
        await page.keyboard.press('Control+Shift+P');

        const widget = page.locator('[data-testid="quick-input-widget"]');
        await expect(widget).toBeVisible();

        const input = page.locator('[data-testid="quick-input-text-input"]');
        await expect(input).toBeFocused();
        await expect(input).toHaveAttribute('placeholder', 'Type the name of a command to run...');

        // Verify quick pick list has populated commands
        const list = page.locator('[data-testid="quick-pick-list"]');
        await expect(list).toBeVisible();
        const items = list.locator('.quick-pick-item');
        await expect(items).not.toHaveCount(0);

        // Verify compact 500px widget width
        const box = await widget.boundingBox();
        expect(box?.width).toBe(500);

        // Verify commands do not have "JJ View: " prefix and do not display command ID
        const commitItem = page.locator('[data-testid="quick-pick-item-jj-view.commit"]');
        await expect(commitItem).toBeVisible();
        await expect(commitItem).toContainText('Commit');
        await expect(commitItem).not.toContainText('JJ View: Commit');
        await expect(commitItem).not.toContainText('jj-view.commit');
        await expect(commitItem.locator('.item-description')).toHaveCount(0);

        // Verify omitted commands with when: false per package.json are not present
        await expect(page.locator('[data-testid="quick-pick-item-jj-view.squashFilesIntoParent"]')).toHaveCount(0);
        await expect(page.locator('[data-testid="quick-pick-item-jj-view.openMergeEditor"]')).toHaveCount(0);
        await expect(page.locator('[data-testid="quick-pick-item-jj-view.showComments"]')).toHaveCount(0);
        await expect(page.locator('[data-testid="quick-pick-item-jj-view.killProcess"]')).toHaveCount(0);
        await expect(page.locator('[data-testid="quick-pick-item-jj-view.completeSquashRevision"]')).toHaveCount(0);

        // Close via Escape key
        await page.keyboard.press('Escape');
        await expect(widget).toHaveCount(0);

        // Trigger Command Palette with F1 key
        await page.keyboard.press('F1');
        await expect(widget).toBeVisible();

        // Close via backdrop click
        const backdrop = page.locator('[data-testid="quick-input-backdrop"]');
        await backdrop.click({ position: { x: 10, y: 10 } });
        await expect(widget).toHaveCount(0);
    });

    test('should filter commands in real time and navigate with arrow keys', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Open Command Palette
        await page.keyboard.press('Control+Shift+P');
        const widget = page.locator('[data-testid="quick-input-widget"]');
        await expect(widget).toBeVisible();

        const input = page.locator('[data-testid="quick-input-text-input"]');
        await input.fill('Settings');

        // Verify filtered results
        const settingsItem = page.locator('[data-testid="quick-pick-item-workbench.action.openSettings"]');
        await expect(settingsItem).toBeVisible();
        await expect(settingsItem).toContainText('Open Settings');

        // Other unrelated commands should be hidden
        const abandonItem = page.locator('[data-testid="quick-pick-item-jj-view.abandon"]');
        await expect(abandonItem).toHaveCount(0);

        // Navigate with ArrowDown
        const firstActive = page.locator('.quick-pick-item.active');
        await expect(firstActive).toBeVisible();

        await page.keyboard.press('ArrowDown');
        const secondActive = page.locator('.quick-pick-item.active');
        await expect(secondActive).toBeVisible();

        // Navigate back with ArrowUp
        await page.keyboard.press('ArrowUp');
        await expect(page.locator('.quick-pick-item.active')).toBeVisible();

        await page.keyboard.press('Escape');
    });

    test('should execute selected command and open Settings modal', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Open Command Palette
        await page.keyboard.press('Control+Shift+P');
        const widget = page.locator('[data-testid="quick-input-widget"]');
        await expect(widget).toBeVisible();

        const input = page.locator('[data-testid="quick-input-text-input"]');
        await input.fill('Preferences: Open Settings');

        const settingsItem = page.locator('[data-testid="quick-pick-item-workbench.action.openSettings"]');
        await expect(settingsItem).toBeVisible();

        // Press Enter to execute command
        await page.keyboard.press('Enter');

        // Command palette should close
        await expect(widget).toHaveCount(0);

        // Settings modal should open
        const settingsModal = page.locator('[data-testid="settings-modal"]');
        await expect(settingsModal).toBeVisible();
        await expect(settingsModal.locator('#settings-title')).toHaveText('Settings');

        // Close settings modal
        await page.keyboard.press('Escape');
        await expect(settingsModal).toHaveCount(0);
    });

    test('should handle text input box via Set Description (Prompt)', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Open Command Palette
        await page.keyboard.press('Control+Shift+P');
        const widget = page.locator('[data-testid="quick-input-widget"]');
        await expect(widget).toBeVisible();

        const input = page.locator('[data-testid="quick-input-text-input"]');
        await input.fill('Set Description (Prompt)');

        const descPromptItem = page.locator('[data-testid="quick-pick-item-jj-view.describePrompt"]');
        await expect(descPromptItem).toBeVisible();
        await expect(descPromptItem).toContainText('Set Description (Prompt)');
        await expect(descPromptItem).not.toContainText('JJ View:');

        // Execute describePrompt command
        await page.keyboard.press('Enter');

        // Quick Input should transition to input-box mode with prompt
        const prompt = page.locator('[data-testid="quick-input-prompt"]');
        await expect(prompt).toBeVisible();
        await expect(prompt).toHaveText('Set description');

        // Screenshot of text input mode
        const textInputScreenshotPath = path.join(ARTIFACT_DIR, 'quick-input-text-entry.png');
        await page.screenshot({ path: textInputScreenshotPath });

        // Enter new description
        await input.fill('docs: update description from prompt');
        await page.keyboard.press('Enter');

        // Input widget should close
        await expect(widget).toHaveCount(0);
    });

    test('should capture screenshots and animated GIF of command palette flow', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const gifOutputPath = path.join(ARTIFACT_DIR, 'command-palette-flow.gif');
        const openScreenshotPath = path.join(ARTIFACT_DIR, 'command-palette-open.png');
        const searchScreenshotPath = path.join(ARTIFACT_DIR, 'command-palette-search.png');

        await recordGifFlow(
            page,
            async (capture) => {
                // Frame 0: Clean initial view
                await capture();

                // Open Command Palette
                await page.keyboard.press('Control+Shift+P');
                const widget = page.locator('[data-testid="quick-input-widget"]');
                await expect(widget).toBeVisible();

                // Frame 1: Command palette open
                await capture();
                await page.screenshot({ path: openScreenshotPath });

                // Type query to filter commands
                const input = page.locator('[data-testid="quick-input-text-input"]');
                await input.fill('Settings');

                // Frame 2: Filtering results
                await capture();
                await page.screenshot({ path: searchScreenshotPath });

                // Navigate with ArrowDown
                await page.keyboard.press('ArrowDown');

                // Frame 3: Active selection on item
                await capture();

                // Execute command
                await page.keyboard.press('Enter');
                const settingsModal = page.locator('[data-testid="settings-modal"]');
                await expect(settingsModal).toBeVisible();

                // Frame 4: Settings modal displayed
                await capture();

                // Close settings
                await page.keyboard.press('Escape');
                await expect(settingsModal).toHaveCount(0);

                // Frame 5: Closed back to normal
                await capture();
            },
            { outputPath: gifOutputPath },
        );

        expect(fs.existsSync(gifOutputPath)).toBe(true);
    });
});
