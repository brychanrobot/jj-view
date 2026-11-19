/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { ARTIFACT_DIR, expect, recordInteractionFlow, save, test, waitForScmReady } from './standalone-fixture';

async function switchColorTheme(page: Page, themeId: 'github-light' | 'pierre-dark-soft'): Promise<void> {
    await page.keyboard.press('Control+Shift+P');
    const paletteInput = page.locator('[data-testid="quick-input-text-input"]');
    await paletteInput.waitFor({ state: 'visible' });
    await paletteInput.fill('Color Theme');
    await page.locator('[data-testid="quick-pick-item-workbench.action.selectTheme"]').click();
    await paletteInput.fill(themeId);
    await page.locator(`[data-testid="quick-pick-item-${themeId}"]`).click();
    const expectedClass = themeId === 'github-light' ? /\bvscode-light\b/ : /\bvscode-dark\b/;
    await expect(page.locator('body')).toHaveClass(expectedClass);
}

test.describe('Backslash Filenames E2E (#435)', () => {
    test.skip(process.platform === 'win32', 'Literal backslashes in file names only exist on POSIX');

    test('renders, diffs, and edits files with literal backslashes in dark and light themes', async ({
        page,
        server,
        testRepo,
    }) => {
        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

        const pageErrors: string[] = [];
        page.on('pageerror', (err) => {
            const isExpectedAgentApiUnavailable =
                err.message.includes('agentapi failed') || err.message.includes('agentapi binary not found');
            if (!isExpectedAgentApiUnavailable) {
                pageErrors.push(err.message);
            }
        });

        testRepo.writeFile('foo\\bar.txt', 'first line\nsecond line\n');
        testRepo.writeFile('sub/a\\b.txt', 'nested original\n');
        testRepo.describe('feat: add backslash files');
        const parentChangeId = testRepo.getChangeId('@');

        testRepo.new(undefined, 'wip: modify backslash files');
        testRepo.writeFile('foo\\bar.txt', 'first line\nsecond line edited\nthird line\n');
        testRepo.writeFile('sub/a\\b.txt', 'nested working edit\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        await recordInteractionFlow(
            page,
            {
                gifPath: path.join(ARTIFACT_DIR, 'backslash-filenames-after.gif'),
                mp4Path: path.join(ARTIFACT_DIR, 'backslash-filenames-after.mp4'),
                fps: 24,
                scale: 1280,
            },
            async (rec) => {
                await rec.setHud('AFTER: SCM preserves foo\\bar.txt and sub/a\\b.txt');
                await rec.hover(8);

                const wcGroup = page.locator('[data-testid="scm-group-working-copy"]');
                const wcFooItem = wcGroup
                    .locator('[data-testid="scm-resource-item"]')
                    .filter({ has: page.locator('.file-name', { hasText: 'foo\\bar.txt' }) });
                const wcSubItem = wcGroup
                    .locator('[data-testid="scm-resource-item"]')
                    .filter({ has: page.locator('.file-name', { hasText: 'a\\b.txt' }) });

                await expect(wcFooItem).toBeVisible();
                await expect(wcFooItem).toHaveAttribute('data-path', 'foo\\bar.txt');
                await expect(wcFooItem.locator('.file-name')).toHaveText('foo\\bar.txt');
                await expect(wcFooItem.locator('.dir-name')).toHaveCount(0);

                await expect(wcSubItem).toBeVisible();
                await expect(wcSubItem).toHaveAttribute('data-path', 'sub/a\\b.txt');
                await expect(wcSubItem.locator('.file-name')).toHaveText('a\\b.txt');
                await expect(wcSubItem.locator('.dir-name')).toHaveText('sub');

                // Verify Quick Open (Ctrl+P) finds files with literal backslashes cleanly
                await rec.setHud('AFTER: Quick Open (Ctrl+P) finds foo\\bar.txt');
                await page.keyboard.press('Control+p');
                const quickInput = page.locator('[data-testid="quick-input-widget"]');
                await expect(quickInput).toBeVisible({ timeout: 5000 });
                const quickSearch = page.locator('[data-testid="quick-input-text-input"]');
                await quickSearch.fill('foo\\bar');
                const quickItems = quickInput.locator('.quick-pick-item');
                await expect(quickItems.first().locator('.item-label')).toHaveText('foo\\bar.txt');
                await quickSearch.fill('a\\b');
                await expect(quickItems.first().locator('.item-label')).toHaveText('a\\b.txt');
                await expect(quickItems.first().locator('.item-description')).toHaveText('sub');
                await page.keyboard.press('Escape');
                await expect(quickInput).toBeHidden();

                // Open Working Copy diff for foo\bar.txt and verify rendered diff + in-place edit/save
                await rec.setHud('AFTER: Open Working Copy diff & edit foo\\bar.txt');
                await rec.click(wcFooItem.locator('.file-name'), 6);

                const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
                await expect(diffViewer).toBeVisible({ timeout: 30000 });
                await expect(diffViewer).toContainText('second line edited');
                await expect(page.locator('.tab-label').first()).toContainText('foo\\bar.txt');

                const editor = diffViewer.getByRole('textbox');
                await expect(editor).toBeVisible({ timeout: 15000 });
                const editableLine = editor.locator('[data-line]').last();
                await expect(async () => {
                    await editableLine.click();
                    await expect(editor).toBeFocused({ timeout: 500 });
                    await expect(editableLine).toHaveAttribute('data-editor-active-line', '', { timeout: 500 });
                }).toPass({ timeout: 10000 });

                await editor.pressSequentially('\nsaved wc line', { delay: 10 });
                await save(page);
                await expect
                    .poll(() => testRepo.getFileContent('@', 'foo\\bar.txt'), { timeout: 15000 })
                    .toContain('saved wc line');

                await rec.hover(8);
                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'backslash-filenames-after-dark.png') });

                // Open Commit Details for mutable ancestor and verify both backslash file rows
                await rec.setHud('AFTER: Commit Details preserves backslashes');
                const ancestorRow = page.locator('[data-testid="log-content"] .commit-row', {
                    hasText: 'feat: add backslash files',
                });
                await expect(ancestorRow).toBeVisible();
                await rec.click(ancestorRow.locator('.commit-desc'), 6);

                const detailsView = page.locator('[data-testid="commit-details-view"]');
                await expect(detailsView).toBeVisible();

                const detailsFooRow = detailsView.locator('.file-row').filter({ hasText: 'foo\\bar.txt' });
                const detailsSubRow = detailsView.locator('.file-row').filter({ hasText: 'sub/a\\b.txt' });
                await expect(detailsFooRow).toBeVisible();
                await expect(detailsSubRow).toBeVisible();
                await expect(detailsFooRow).toHaveAttribute('data-file-path', 'foo\\bar.txt');
                await expect(detailsSubRow).toHaveAttribute('data-file-path', 'sub/a\\b.txt');

                // Switch to Light theme and edit mutable ancestor via jj-edit://
                await rec.setHud('AFTER: Light theme jj-edit:// save on sub/a\\b.txt');
                await switchColorTheme(page, 'github-light');

                await rec.click(detailsSubRow.locator('.file-name'), 6);
                await expect(diffViewer).toBeVisible({ timeout: 30000 });
                await expect(diffViewer).toContainText('nested original');

                const ancestorEditor = diffViewer.getByRole('textbox');
                await expect(ancestorEditor).toBeVisible({ timeout: 15000 });
                const ancestorLastLine = ancestorEditor.locator('[data-line]').last();
                await expect(async () => {
                    await ancestorLastLine.click();
                    await expect(ancestorEditor).toBeFocused({ timeout: 500 });
                    await expect(ancestorLastLine).toHaveAttribute('data-editor-active-line', '', { timeout: 500 });
                }).toPass({ timeout: 10000 });

                await ancestorEditor.pressSequentially('\nsaved jj-edit line', { delay: 10 });
                await save(page);
                await expect
                    .poll(() => testRepo.getFileContent(parentChangeId, 'sub/a\\b.txt'), { timeout: 15000 })
                    .toContain('saved jj-edit line');

                await rec.hover(8);
                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'backslash-filenames-after-light.png') });
            },
        );

        expect(pageErrors).toEqual([]);
    });
});
