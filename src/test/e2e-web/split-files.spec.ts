/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { buildGraph, type TestRepo } from '../test-repo';
import { ARTIFACT_DIR, expect, recordInteractionFlow, test, waitForScmReady } from './standalone-fixture';

function getChangedFiles(repo: TestRepo, revision: string): string[] {
    const raw = repo.getLog(revision, 'diff.files().map(|f| f.path()).join(",")').trim();
    if (!raw) {
        return [];
    }
    return raw.split(',').filter(Boolean).sort();
}

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

async function readMenuColors(menu: Locator): Promise<{ backgroundColor: string; color: string; borderColor: string }> {
    return menu.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return {
            backgroundColor: style.backgroundColor,
            color: style.color,
            borderColor: style.borderColor,
        };
    });
}

test.describe('Standalone Web Split Files (Issue #612)', () => {
    test('multi-selects files, flushes draft, splits before/after in dark & light themes, and respects immutability', async ({
        page,
        server,
        testRepo,
    }) => {
        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

        const ids = await buildGraph(testRepo, [
            {
                label: 'immBase',
                description: 'immutable base commit',
                files: { 'base-only.txt': 'immutable content\n' },
            },
            {
                label: 'target',
                parents: ['immBase'],
                description: 'feat: target bundle',
                files: {
                    'alpha.txt': 'alpha v1\n',
                    'beta.txt': 'beta v1\n',
                    'gamma.txt': 'gamma v1\n',
                    'delta.txt': 'delta v1\n',
                },
            },
            {
                label: 'wc',
                parents: ['target'],
                description: 'wip: working copy',
                files: { 'wc-a.txt': 'wc a\n', 'wc-b.txt': 'wc b\n' },
                isCurrentWorkingCopy: true,
            },
        ]);
        testRepo.tag('v1.0.0', ids.immBase.changeId);

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const targetRow = page.locator('[data-testid="log-content"] .commit-row', { hasText: 'feat: target bundle' });
        await expect(targetRow).toBeVisible();
        await targetRow.locator('.commit-desc').click();

        const detailsView = page.locator('[data-testid="commit-details-view"]');
        const textarea = detailsView.locator('.commit-textarea');
        await expect(textarea).toHaveValue('feat: target bundle');

        const fileRows = detailsView.locator('.file-row');
        await expect(fileRows).toHaveCount(4);

        const alphaRow = detailsView.locator('.file-row[data-file-path="alpha.txt"]');
        const betaRow = detailsView.locator('.file-row[data-file-path="beta.txt"]');
        const gammaRow = detailsView.locator('.file-row[data-file-path="gamma.txt"]');
        const deltaRow = detailsView.locator('.file-row[data-file-path="delta.txt"]');
        const tabs = page.locator('[data-testid="tab-bar-container"] .tab');

        // Pin Commit Details tab so opening a file diff tab does not replace the preview tab
        const commitDetailsTab = tabs.first();
        await expect(commitDetailsTab).toBeVisible();
        await commitDetailsTab.dblclick();
        await expect(commitDetailsTab).not.toHaveClass(/preview/);

        // Plain click opens diff tab (and preserves plain-click diff behavior)
        await alphaRow.click();
        await expect(tabs.filter({ hasText: 'alpha.txt' })).toHaveCount(1);
        // Close the diff tab to return to Commit Details
        await page.keyboard.press('Control+w');
        await expect(tabs.filter({ hasText: 'alpha.txt' })).toHaveCount(0);
        await expect(detailsView).toBeVisible();

        // Ctrl+click toggles alpha.txt selection without opening diff
        await alphaRow.click({ modifiers: ['Control'] });
        await expect(alphaRow).toHaveAttribute('data-selected', 'true');
        await expect(tabs.filter({ hasText: 'alpha.txt' })).toHaveCount(0);

        // Files are sorted alphabetically: alpha.txt, beta.txt, delta.txt, gamma.txt
        // Shift+click on delta.txt selects contiguous range alpha..delta without opening diff tabs
        await deltaRow.click({ modifiers: ['Shift'] });
        await expect(alphaRow).toHaveAttribute('data-selected', 'true');
        await expect(betaRow).toHaveAttribute('data-selected', 'true');
        await expect(deltaRow).toHaveAttribute('data-selected', 'true');
        await expect(gammaRow).toHaveAttribute('data-selected', 'false');
        await expect(tabs.filter({ hasText: 'beta.txt' })).toHaveCount(0);
        await expect(tabs.filter({ hasText: 'delta.txt' })).toHaveCount(0);

        // Ctrl+click toggles beta.txt off without opening diff
        await betaRow.click({ modifiers: ['Control'] });
        await expect(alphaRow).toHaveAttribute('data-selected', 'true');
        await expect(betaRow).toHaveAttribute('data-selected', 'false');
        await expect(deltaRow).toHaveAttribute('data-selected', 'true');
        await expect(tabs.filter({ hasText: 'beta.txt' })).toHaveCount(0);

        // Escape inside textarea must preserve file selection
        await textarea.focus();
        await page.keyboard.press('Escape');
        await expect(alphaRow).toHaveAttribute('data-selected', 'true');
        await expect(deltaRow).toHaveAttribute('data-selected', 'true');

        // Escape on file row clears selection
        await alphaRow.focus();
        await page.keyboard.press('Escape');
        for (const row of [alphaRow, betaRow, gammaRow, deltaRow]) {
            await expect(row).toHaveAttribute('data-selected', 'false');
        }

        // Animated flow (dark theme): Ctrl+click multi-select -> unsaved draft -> right-click -> Split Before
        let darkMenuColors: { backgroundColor: string; color: string; borderColor: string } | undefined;
        await recordInteractionFlow(
            page,
            { gifPath: path.join(ARTIFACT_DIR, 'split-files-flow.gif'), fps: 24, scale: 1280 },
            async (rec) => {
                await rec.setHud('Select multiple files in Commit Details');
                await rec.moveTo(alphaRow, 14);
                await alphaRow.click({ modifiers: ['Control'] });
                await rec.hover(4);
                await rec.moveTo(betaRow, 14);
                await betaRow.click({ modifiers: ['Control'] });
                await expect(alphaRow).toHaveAttribute('data-selected', 'true');
                await expect(betaRow).toHaveAttribute('data-selected', 'true');
                await rec.hover(8);

                // Enter an unsaved draft right before splitting to verify flushPendingSave()
                await rec.setHud('Edit description draft & right-click Split Before');
                await textarea.fill('feat: target bundle (draft saved)');
                await rec.moveTo(betaRow, 14);
                await betaRow.click({ button: 'right' });

                const fileMenu = page.locator('[data-testid="commit-details-file-context-menu"]');
                await expect(fileMenu).toBeVisible();
                darkMenuColors = await readMenuColors(fileMenu);
                expect(darkMenuColors.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
                expect(darkMenuColors.backgroundColor).not.toBe('transparent');

                // Ensure floating menu fits cleanly within the viewport
                const box = await fileMenu.boundingBox();
                const viewport = page.viewportSize();
                expect(box).not.toBeNull();
                expect(viewport).not.toBeNull();
                if (box && viewport) {
                    expect(box.x).toBeGreaterThanOrEqual(0);
                    expect(box.y).toBeGreaterThanOrEqual(0);
                    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
                    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
                }

                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'split-files-details-menu-dark.png') });
                await rec.hover(10);

                await rec.click(page.locator('[data-testid="details-split-before"]'));

                await expect
                    .poll(() => getChangedFiles(testRepo, ids.target.changeId))
                    .toEqual(['delta.txt', 'gamma.txt']);
                await expect
                    .poll(() => testRepo.getLog(ids.target.changeId, 'description').trim())
                    .toBe('feat: target bundle (draft saved)');

                await expect(fileRows).toHaveCount(2);
                await rec.setHud('New change inserted before target commit');
                await rec.hover(14);
            },
        );

        const [insertedBeforeId] = testRepo.getParents(ids.target.changeId);
        expect(insertedBeforeId).toBeDefined();
        expect(insertedBeforeId).not.toBe(ids.immBase.changeId);
        expect(testRepo.getParents(insertedBeforeId)).toEqual([ids.immBase.changeId]);
        expect(getChangedFiles(testRepo, insertedBeforeId)).toEqual(['alpha.txt', 'beta.txt']);
        expect(testRepo.getLog(insertedBeforeId, 'description').trim()).toBe('');

        // Switch to light theme (github-light) and split delta.txt into a new change AFTER
        await switchColorTheme(page, 'github-light');
        await deltaRow.click({ button: 'right' });

        const lightMenu = page.locator('[data-testid="commit-details-file-context-menu"]');
        await expect(lightMenu).toBeVisible();
        const lightMenuColors = await readMenuColors(lightMenu);
        expect(lightMenuColors.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
        expect(lightMenuColors.backgroundColor).not.toBe('transparent');
        expect(lightMenuColors.color).not.toBe(lightMenuColors.backgroundColor);
        expect(lightMenuColors.backgroundColor).not.toBe(darkMenuColors?.backgroundColor);

        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'split-files-details-menu-light.png') });
        await page.locator('[data-testid="details-split-after"]').click();

        await expect.poll(() => getChangedFiles(testRepo, ids.target.changeId)).toEqual(['gamma.txt']);
        await expect(fileRows).toHaveCount(1);
        await expect(gammaRow).toBeVisible();

        const targetChildren = testRepo.getChildren(ids.target.changeId);
        expect(targetChildren).toHaveLength(1);
        const [insertedAfterId] = targetChildren;
        expect(insertedAfterId).not.toBe(ids.wc.changeId);
        expect(getChangedFiles(testRepo, insertedAfterId)).toEqual(['delta.txt']);
        expect(testRepo.getChildren(insertedAfterId)).toEqual([ids.wc.changeId]);

        // Restore dark theme before continuing
        await switchColorTheme(page, 'pierre-dark-soft');

        // Immutable commit exposes remote file actions in Commit Details context menu, never split actions
        const immRow = page.locator('[data-testid="log-content"] .commit-row', { hasText: 'immutable base commit' });
        await immRow.locator('.commit-desc').click();
        await expect(textarea).toHaveValue('immutable base commit');
        await expect(textarea).toBeDisabled();
        const immFileRow = detailsView.locator('.file-row[data-file-path="base-only.txt"]');
        await expect(immFileRow).toBeVisible();
        await immFileRow.click({ button: 'right' });
        const immContextMenu = page.locator('[data-testid="commit-details-file-context-menu"]');
        await expect(immContextMenu).toBeVisible();
        await expect(immContextMenu.locator('[data-testid="details-split-before"]')).toHaveCount(0);
        await expect(immContextMenu.locator('[data-testid="details-split-after"]')).toHaveCount(0);
        await expect(immContextMenu.locator('[data-testid="details-open-file-on-remote"]')).toBeVisible();
        await expect(immContextMenu.locator('[data-testid="details-copy-remote-file-url"]')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(immContextMenu).toHaveCount(0);

        // Right-clicking a Working Changes resource in SCM Pane exposes Split Before / Split After
        const wcGroup = page.locator('[data-testid="scm-group-working-copy"]');
        const wcFileItem = wcGroup.locator('[data-testid="scm-resource-item"]', { hasText: 'wc-a.txt' });
        await expect(wcFileItem).toBeVisible();
        await wcFileItem.click({ button: 'right' });

        const scmContextMenu = page.locator('[data-testid="context-menu"]');
        await expect(scmContextMenu).toBeVisible();
        const scmSplitBefore = scmContextMenu.locator('[data-testid="menu-item-jj-view.splitFilesBefore"]');
        const scmSplitAfter = scmContextMenu.locator('[data-testid="menu-item-jj-view.splitFilesAfter"]');
        await expect(scmSplitBefore).toBeVisible();
        await expect(scmSplitAfter).toBeVisible();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'split-files-scm-menu-dark.png') });

        await scmSplitBefore.click();
        await expect.poll(() => getChangedFiles(testRepo, ids.wc.changeId)).toEqual(['wc-b.txt']);
        const [wcNewParent] = testRepo.getParents(ids.wc.changeId);
        expect(getChangedFiles(testRepo, wcNewParent)).toEqual(['wc-a.txt']);
        expect(testRepo.getParents(wcNewParent)).toEqual([insertedAfterId]);

        // Right-clicking a mutable ancestor resource in SCM Pane also exposes Split Before / Split After
        const ancestorGroup = page.locator('[data-testid="scm-group-ancestor-0"]');
        const ancestorItem = ancestorGroup.locator('[data-testid="scm-resource-item"]', { hasText: 'wc-a.txt' });
        await expect(ancestorItem).toBeVisible();
        await ancestorItem.click({ button: 'right' });
        await expect(scmContextMenu).toBeVisible();
        await expect(scmContextMenu.locator('[data-testid="menu-item-jj-view.splitFilesBefore"]')).toBeVisible();
        await expect(scmContextMenu.locator('[data-testid="menu-item-jj-view.splitFilesAfter"]')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(scmContextMenu).toHaveCount(0);
    });
});
