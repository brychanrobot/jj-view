/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import { TestRepo } from '../test-repo';
import { focusSCM, launchVSCode } from './e2e-helpers';

test.describe('Quick Diff E2E', () => {
    test('Gutter decorations and Diff Editor refresh after squash', async () => {
        const repo = new TestRepo();
        repo.init();
        
        // Initial state: one commit with a file
        const fileName = 'quick-diff-test.txt';
        repo.writeFile(fileName, 'line 1\nline 2\nline 3\n');
        repo.describe('base');
        
        // Working copy modification: add a line
        repo.new();
        repo.writeFile(fileName, 'line 1\nline 2\nline 2.5\nline 3\n');

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            // 1. Open the file via the Explorer
            await page.keyboard.press('Control+Shift+E');
            const fileRowInExplorer = page.getByRole('treeitem', { name: fileName }).first();
            await expect(fileRowInExplorer).toBeVisible({ timeout: 10000 });
            await fileRowInExplorer.click();

            // Wait for the tab to be active
            await expect(page.getByRole('tab', { name: fileName, selected: true })).toBeVisible({ timeout: 10000 });

            // Wait for editor to be visible and focused
            const editor = page.locator('.editor-group-container.active .monaco-editor');
            await expect(editor).toBeVisible({ timeout: 10000 });

            // 2. Verify Gutter Indicator
            // VS Code uses specific titles for diff indicators in the gutter
            const gutter = editor.locator('[title="Added lines"], [title="Changed lines"], [title="Deleted lines"]');
            await expect(gutter.first()).toBeVisible({ timeout: 15000 });

            // 3. Open Peek View
            const peekView = page.locator('.monaco-editor .zone-widget');
            await expect(async () => {
                // Focus editor
                await editor.click();
                
                // Attempt edge-click (as user showed in screenshot, the visual bar is far-left)
                const target = gutter.first();
                const box = await target.boundingBox();
                if (box) {
                    await page.mouse.click(box.x + 1, box.y + box.height / 2, { delay: 100 });
                }
                
                // Wait for Peek View to appear
                await expect(peekView).toBeVisible({ timeout: 5000 });
            }).toPass({ timeout: 20000 });

            // The peek view contains a diff editor
            await expect(peekView.locator('.editor.original')).toContainText('line 2', { timeout: 5000 });

            // 4. Perform Squash (Mutation)
            // We use the CLI via TestRepo to simulate an external change that triggers a refresh
            repo.squash();
            
            // 5. Verify Refresh in UI
            // The Peek View should ideally close or update.
            // And the gutter indicator must disappear.
            await expect(gutter.first()).not.toBeVisible({ timeout: 15000 });
            await expect(peekView).not.toBeVisible({ timeout: 5000 });

            // 6. Verify Diff Editor refresh (from SCM pane)
            await focusSCM(page);
            // Use a specific name that includes the status to disambiguate from Explorer
            const scmFileRow = page.getByRole('treeitem', { name: new RegExp(`${fileName}.*modified`, 'i') });
            // Since it's squashed, it might still show up briefly or disappear.
            // Actually, after squash, the file matches the parent, so it should disappear from SCM.
            await expect(scmFileRow).not.toBeVisible({ timeout: 10000 });

        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });
});
