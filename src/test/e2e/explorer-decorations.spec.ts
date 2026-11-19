/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { isMac, test } from './e2e-helpers';

function escapeCssAttrValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function explorerRow(page: Page, fullPath: string): Locator {
    const escapedPath = escapeCssAttrValue(fullPath);
    const labelSelector = [
        `.monaco-icon-label[aria-label="${escapedPath}" i]`,
        `.monaco-icon-label[aria-label^="${escapedPath} •" i]`,
        `.monaco-icon-label[aria-label^="${escapedPath}," i]`,
    ].join(', ');
    return page.locator('.explorer-folders-view .monaco-list-row').filter({
        has: page.locator(labelSelector),
    });
}

async function expandExplorerRow(page: Page, fullPath: string): Promise<Locator> {
    const row = explorerRow(page, fullPath).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    const expanded = await row.getAttribute('aria-expanded');
    if (expanded === 'false') {
        await row.click();
        await expect(row).toHaveAttribute('aria-expanded', 'true', { timeout: 5000 });
    }
    return row;
}

test.describe('Explorer Symlink Folder Decorations E2E', () => {
    test('Symlinked folder contents preserve tracked and modified decorations across themes (#202)', async ({
        vscode,
    }) => {
        const repo = new TestRepo();
        let activePage: Page | undefined;
        let originalColorTheme: string | undefined;
        let changedTheme = false;

        try {
            repo.init();
            repo.writeFile('.gitignore', '*.ignored\n');
            repo.writeFile('docs/guide.md', '# Guide\nInitial documentation content.\n');
            repo.writeFile('docs/sub/nested.md', '# Nested\nNested documentation content.\n');
            repo.writeFile('docs/local.ignored', 'ignored artifact\n');
            repo.writeFile('cli/index.ts', 'export const cliVersion = 1;\n');
            fs.symlinkSync(
                '../docs',
                path.join(repo.path, 'cli', 'docs'),
                process.platform === 'win32' ? 'junction' : 'dir',
            );
            repo.snapshot();
            repo.describe('feat: add docs and symlinked cli/docs');
            repo.new([], 'working copy');

            const { page } = await vscode.openWorkspace(repo);
            activePage = page;
            originalColorTheme = await vscode.evaluate((vscodeApi) =>
                vscodeApi.workspace.getConfiguration('workbench').get<string>('colorTheme'),
            );

            await page.keyboard.press(isMac ? 'Meta+Shift+E' : 'Control+Shift+E');
            await page.keyboard.press('Control+Alt+E');

            const explorerTree = page.locator('.explorer-folders-view .monaco-list').first();
            await expect(explorerTree).toBeVisible({ timeout: 10000 });

            await expandExplorerRow(page, repo.path);
            await expandExplorerRow(page, path.join(repo.path, 'docs'));
            await expandExplorerRow(page, path.join(repo.path, 'docs', 'sub'));
            await expandExplorerRow(page, path.join(repo.path, 'cli'));
            const symDocsRow = await expandExplorerRow(page, path.join(repo.path, 'cli', 'docs'));
            const symSub = await expandExplorerRow(page, path.join(repo.path, 'cli', 'docs', 'sub'));

            const realGuide = explorerRow(page, path.join(repo.path, 'docs', 'guide.md')).first();
            const realIgnored = explorerRow(page, path.join(repo.path, 'docs', 'local.ignored')).first();
            const symGuide = explorerRow(page, path.join(repo.path, 'cli', 'docs', 'guide.md')).first();
            const symNested = explorerRow(page, path.join(repo.path, 'cli', 'docs', 'sub', 'nested.md')).first();
            const symIgnored = explorerRow(page, path.join(repo.path, 'cli', 'docs', 'local.ignored')).first();

            await expect(realGuide).toBeVisible({ timeout: 5000 });
            await expect(symGuide).toBeVisible({ timeout: 5000 });
            await expect(symNested).toBeVisible({ timeout: 5000 });

            // Genuinely ignored entries remain Ignored while tracked symlinked contents are not Ignored
            await expect(realIgnored.locator('.monaco-icon-label[aria-label*="Ignored"]')).toBeVisible({
                timeout: 10000,
            });
            await expect(symIgnored.locator('.monaco-icon-label[aria-label*="Ignored"]')).toBeVisible({
                timeout: 10000,
            });
            await expect(realGuide.locator('.monaco-icon-label[aria-label*="Ignored"]')).toHaveCount(0);
            await expect(symDocsRow.locator('.monaco-icon-label[aria-label*="Ignored"]')).toHaveCount(0);
            await expect(symGuide.locator('.monaco-icon-label[aria-label*="Ignored"]')).toHaveCount(0);
            await expect(symSub.locator('.monaco-icon-label[aria-label*="Ignored"]')).toHaveCount(0);
            await expect(symNested.locator('.monaco-icon-label[aria-label*="Ignored"]')).toHaveCount(0);

            // Editing the canonical target updates SCM Modified decorations on the symlinked view and open tab
            repo.writeFile('docs/guide.md', '# Guide\nUpdated documentation content.\n');
            await page.keyboard.press('Control+Alt+E');
            await expect(realGuide.locator('.monaco-icon-label[aria-label*="Modified"]')).toBeVisible({
                timeout: 10000,
            });
            await expect(symGuide.locator('.monaco-icon-label[aria-label*="Modified"]')).toBeVisible({
                timeout: 10000,
            });
            await expect(symGuide.locator('.monaco-icon-label[aria-label*="Ignored"]')).toHaveCount(0);

            const darkModifiedColor = await realGuide
                .locator('.label-name')
                .first()
                .evaluate((el) => getComputedStyle(el).color);
            await expect
                .poll(async () =>
                    symGuide
                        .locator('.label-name')
                        .first()
                        .evaluate((el) => getComputedStyle(el).color),
                )
                .toBe(darkModifiedColor);

            await symGuide.click();
            const guideTab = page.locator('.tab[role="tab"]', { hasText: 'guide.md' }).first();
            await expect(guideTab).toBeVisible({ timeout: 5000 });
            await expect(guideTab.locator('[aria-label*="Ignored"]')).toHaveCount(0);
            await expect
                .poll(async () =>
                    guideTab
                        .locator('.label-name')
                        .first()
                        .evaluate((el) => getComputedStyle(el).color),
                )
                .toBe(darkModifiedColor);

            // Verify decorations remain consistent in Default Light Modern theme
            changedTheme = true;
            await vscode.evaluate(async (vscodeApi) => {
                await vscodeApi.workspace
                    .getConfiguration('workbench')
                    .update('colorTheme', 'Default Light Modern', vscodeApi.ConfigurationTarget.Global);
            });
            await expect(page.locator('.monaco-workbench')).toHaveClass(/(?:^|\s)vs(?:\s|$)/, { timeout: 10000 });
            await expect(symGuide.locator('.monaco-icon-label[aria-label*="Modified"]')).toBeVisible({
                timeout: 5000,
            });
            await expect(symNested.locator('.monaco-icon-label[aria-label*="Ignored"]')).toHaveCount(0);
            await expect(symIgnored.locator('.monaco-icon-label[aria-label*="Ignored"]')).toBeVisible({
                timeout: 5000,
            });

            const lightModifiedColor = await realGuide
                .locator('.label-name')
                .first()
                .evaluate((el) => getComputedStyle(el).color);
            expect(lightModifiedColor).not.toBe(darkModifiedColor);
            const realItemColorClass = await realGuide
                .locator('.monaco-icon-label')
                .first()
                .evaluate((el) => Array.from(el.classList).find((c) => c.startsWith('monaco-decoration-itemColor-')));
            expect(realItemColorClass).toBeDefined();
            const symItemColorClass = await symGuide
                .locator('.monaco-icon-label')
                .first()
                .evaluate((el) => Array.from(el.classList).find((c) => c.startsWith('monaco-decoration-itemColor-')));
            expect(symItemColorClass).toBe(realItemColorClass);
            await expect
                .poll(async () =>
                    guideTab
                        .locator('.label-name')
                        .first()
                        .evaluate((el) => getComputedStyle(el).color),
                )
                .toBe(lightModifiedColor);
        } finally {
            if (changedTheme) {
                const targetTheme = originalColorTheme ?? 'Default Dark Modern';
                await vscode
                    .evaluate(async (vscodeApi, _api, themeVal) => {
                        if (typeof themeVal !== 'string') {
                            return;
                        }
                        await vscodeApi.workspace
                            .getConfiguration('workbench')
                            .update('colorTheme', themeVal, vscodeApi.ConfigurationTarget.Global);
                    }, targetTheme)
                    .catch(() => {});
                if (targetTheme !== 'Default Light Modern' && activePage && !activePage.isClosed()) {
                    await expect(activePage.locator('.monaco-workbench'))
                        .not.toHaveClass(/(?:^|\s)vs(?:\s|$)/, { timeout: 10000 })
                        .catch(() => {});
                }
            }
            await vscode.closeAllEditors().catch(() => {});
            if (activePage) {
                await vscode.clearRepositoryManager().catch(() => {});
            }
            await repo.dispose();
        }
    });
});
