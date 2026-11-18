/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { buildGraph } from '../test-repo';
import { ARTIFACT_DIR, expect, recordGifFlow, save, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web In-Place Diff Editing & Conflicts', () => {
    test('should allow editing working copy files and discarding changes via SCM', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('notes.txt', 'original line 1\noriginal line 2\n');
        testRepo.describe('initial notes');
        testRepo.new();

        testRepo.writeFile('notes.txt', 'original line 1\nmodified line 2\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Click the modified resource
        const resourceItem = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'notes.txt' });
        await expect(resourceItem).toBeVisible();
        await resourceItem.click();

        // Verify Pierre Diff Viewer mounts
        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 15000 });

        // Discard changes via SCM resource action
        await resourceItem.hover();
        const discardBtn = resourceItem.locator('[data-testid="scm-resource-action-jj-view.restore"]');
        await expect(discardBtn).toBeVisible();
        await discardBtn.click();

        // Working copy should now be clean and file restored on disk
        await expect(
            page.locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]'),
        ).toHaveCount(0, { timeout: 15000 });

        const diskContent = testRepo.getFileContent('@', 'notes.txt');
        expect(diskContent).toBe('original line 1\noriginal line 2\n');
    });

    test('should show conflict resolution action when viewing a conflicted file', async ({
        page,
        server,
        testRepo,
    }) => {
        // Build merge conflict graph
        await buildGraph(testRepo, [
            { label: 'base', description: 'base', files: { 'merge-conflict.txt': 'base content\n' } },
            {
                label: 'branch1',
                parents: ['base'],
                description: 'branch 1',
                files: { 'merge-conflict.txt': 'branch 1 content\n' },
            },
            {
                label: 'branch2',
                parents: ['base'],
                description: 'branch 2',
                files: { 'merge-conflict.txt': 'branch 2 content\n' },
            },
            {
                label: 'merge',
                parents: ['branch1', 'branch2'],
                description: 'merge with conflict',
                isCurrentWorkingCopy: true,
            },
        ]);

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Verify Merge Conflicts group is present
        const conflictsGroup = page.locator('[data-testid="scm-group-conflicts"]');
        await expect(conflictsGroup).toBeVisible({ timeout: 5000 });

        const conflictItem = conflictsGroup
            .locator('[data-testid="scm-resource-item"]')
            .filter({ hasText: 'merge-conflict.txt' });
        await expect(conflictItem).toBeVisible();
        await conflictItem.hover();
        const openChangesBtn = conflictItem.locator('[data-testid="scm-resource-action-jj-view.openChanges"]');
        await expect(openChangesBtn).toBeVisible();
        await openChangesBtn.click();

        // Verify Diff Viewer is mounted with conflict resolution button
        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 15000 });

        const resolveBtn = diffViewer.locator('[data-testid="diff-resolve-conflict-btn"]');
        await expect(resolveBtn).toBeVisible();
        await expect(resolveBtn).toContainText('Mark Resolved');
    });

    test('should allow saving edits to disk via keyboard shortcut', async ({ page, server, testRepo }) => {
        testRepo.writeFile('editable.txt', 'line 1\nline 2\n');
        testRepo.describe('initial commit');
        testRepo.new();

        testRepo.writeFile('editable.txt', 'line 1\nline 2 changed\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'editable.txt' });
        await expect(item).toBeVisible();
        await item.locator('.file-name').click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 15000 });

        const editor = diffViewer.getByRole('textbox');
        await expect(editor).toBeVisible({ timeout: 15000 });
        const editableLine = editor.locator('[data-line]').last();
        await expect(async () => {
            await editableLine.click();
            await expect(editor).toBeFocused({ timeout: 500 });
            await expect(editableLine).toHaveAttribute('data-editor-active-line', '', { timeout: 500 });
        }).toPass({ timeout: 10000 });
        await editor.pressSequentially('\nappended edit', { delay: 15 });
        await expect(editor).toContainText('appended edit', { timeout: 5000 });

        // Save via keyboard shortcut
        await save(page);

        await expect
            .poll(() => testRepo.getFileContent('@', 'editable.txt'), { timeout: 15000 })
            .toContain('appended edit');
    });

    test('should allow editing jj-edit files in diffs for mutable parent commits', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('parent-file.txt', 'base line 1\n');
        testRepo.describe('base commit');
        testRepo.new();

        testRepo.writeFile('parent-file.txt', 'base line 1\nparent line 2\n');
        testRepo.describe('mutable parent');
        const parentChangeId = testRepo.getChangeId('@');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const ancestorItem = page
            .locator('[data-testid="scm-group-ancestor-0"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'parent-file.txt' });
        await expect(ancestorItem).toBeVisible();
        await ancestorItem.locator('.file-name').click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 30000 });

        const editor = diffViewer.getByRole('textbox');
        await expect(editor).toBeVisible({ timeout: 15000 });
        const editableLine = editor.locator('[data-line]').last();
        await expect(async () => {
            await editableLine.click();
            await expect(editor).toBeFocused({ timeout: 500 });
            await expect(editableLine).toHaveAttribute('data-editor-active-line', '', { timeout: 500 });
        }).toPass({ timeout: 10000 });
        await editor.pressSequentially('\nparent edit via diff', { delay: 15 });
        await expect(editor).toContainText('parent edit via diff', { timeout: 5000 });

        await save(page);

        await expect
            .poll(() => testRepo.getFileContent(parentChangeId, 'parent-file.txt'), { timeout: 15000 })
            .toContain('parent edit via diff');
    });

    test('should open editable jj-edit diff when clicking a file in Commit Details of a mutable commit', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('details-edit.txt', 'initial\n');
        testRepo.describe('mutable ancestor');
        const ancestorChangeId = testRepo.getChangeId('@');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logContent = page.locator('[data-testid="log-content"]');
        await logContent.locator('.commit-row').filter({ hasText: 'mutable ancestor' }).locator('.commit-desc').click();

        const detailsView = page.locator('[data-testid="commit-details-view"]');
        const fileRow = detailsView.locator('.file-row').filter({ hasText: 'details-edit.txt' });
        await expect(fileRow).toBeVisible({ timeout: 10000 });
        await fileRow.locator('.file-name').click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 30000 });

        const editor = diffViewer.getByRole('textbox');
        await expect(editor).toBeVisible({ timeout: 15000 });
        const editableLine = editor.locator('[data-line]').last();
        await expect(async () => {
            await editableLine.click();
            await expect(editor).toBeFocused({ timeout: 500 });
            await expect(editableLine).toHaveAttribute('data-editor-active-line', '', { timeout: 500 });
        }).toPass({ timeout: 10000 });
        await editor.pressSequentially('\nedited from commit details diff', { delay: 15 });
        await expect(editor).toContainText('edited from commit details diff', { timeout: 5000 });

        await save(page);

        await expect
            .poll(() => testRepo.getFileContent(ancestorChangeId, 'details-edit.txt'), { timeout: 15000 })
            .toContain('edited from commit details diff');
    });

    test('should open mutable ancestor diffs read-only when editableMutableDiffs is false and toggle between read-only and editable across themes', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('parent-file.txt', 'base line 1\n');
        testRepo.describe('base commit');
        testRepo.new();

        testRepo.writeFile('parent-file.txt', 'base line 1\nparent line 2\n');
        testRepo.describe('mutable parent');
        const parentChangeId = testRepo.getChangeId('@');
        testRepo.new();

        testRepo.writeFile('wc-file.txt', 'wc line 1\n');
        testRepo.describe('working copy');

        const pageErrors: string[] = [];
        page.on('pageerror', (err) => {
            const isExpectedAgentApiUnavailable =
                err.message.includes('agentapi failed') || err.message.includes('agentapi binary not found');
            if (!isExpectedAgentApiUnavailable) {
                pageErrors.push(err.message);
            }
        });

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Disable editableMutableDiffs in Settings modal
        await page.locator('[data-testid="scm-settings-button"]').click();
        const modal = page.locator('[data-testid="settings-modal"]');
        await expect(modal).toBeVisible();
        const editableToggle = page.locator('[data-testid="setting-control-editableMutableDiffs"]');
        await expect(editableToggle).toBeChecked();
        await editableToggle.click();
        await expect(editableToggle).not.toBeChecked();
        await page.locator('[data-testid="settings-close-btn"]').click();
        await expect(modal).toHaveCount(0);

        // Working copy (@) diff remains editable even when editableMutableDiffs is false
        const wcItem = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'wc-file.txt' });
        await expect(wcItem).toBeVisible();
        await wcItem.locator('.file-name').click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 30000 });
        await expect(diffViewer).toContainText('wc line 1', { timeout: 15000 });
        await expect(diffViewer.getByRole('textbox')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('[data-testid="editor-title-action-jj-view.enableDiffEditing"]')).toHaveCount(0);

        const darkReadOnlyPng = path.join(ARTIFACT_DIR, 'readonly-mutable-diffs-dark.png');
        const lightReadOnlyPng = path.join(ARTIFACT_DIR, 'readonly-mutable-diffs-light.png');
        const toggleGifPath = path.join(ARTIFACT_DIR, 'readonly-mutable-diffs-toggle.gif');

        await recordGifFlow(
            page,
            async (captureFrame) => {
                // Mutable non-WC ancestor diff opens read-only with Edit Revision File action button
                const ancestorItem = page
                    .locator('[data-testid="scm-group-ancestor-0"] [data-testid="scm-resource-item"]')
                    .filter({ hasText: 'parent-file.txt' });
                await expect(ancestorItem).toBeVisible();
                await ancestorItem.locator('.file-name').click();

                await expect(diffViewer).toContainText('parent line 2', { timeout: 15000 });
                await expect(diffViewer.getByRole('textbox')).toHaveCount(0);

                const enableEditBtn = page.locator('[data-testid="editor-title-action-jj-view.enableDiffEditing"]');
                await expect(enableEditBtn).toBeVisible();
                await page.screenshot({ path: darkReadOnlyPng });
                await captureFrame();

                // Toggle to editable mode (jj-edit) without creating duplicate tabs
                await enableEditBtn.click();

                const disableEditBtn = page.locator('[data-testid="editor-title-action-jj-view.disableDiffEditing"]');
                await expect(disableEditBtn).toBeVisible({ timeout: 15000 });
                await expect(enableEditBtn).toHaveCount(0);
                await expect(
                    page.locator('[data-testid="tab-bar-container"] .tab').filter({ hasText: 'parent-file.txt' }),
                ).toHaveCount(1);

                const editor = diffViewer.getByRole('textbox');
                await expect(editor).toBeVisible({ timeout: 15000 });
                const editableLine = editor.locator('[data-line]').last();
                await expect(async () => {
                    await editableLine.click();
                    await expect(editor).toBeFocused({ timeout: 500 });
                    await expect(editableLine).toHaveAttribute('data-editor-active-line', '', { timeout: 500 });
                }).toPass({ timeout: 10000 });
                await editor.pressSequentially('\ntoggled editable line', { delay: 15 });
                await expect(editor).toContainText('toggled editable line', { timeout: 5000 });
                await captureFrame();

                // Switch to light theme via Settings modal to verify theme adaptation without disturbing dirty editor
                await page.locator('[data-testid="scm-settings-button"]').click();
                await expect(modal).toBeVisible();
                await page.locator('[data-testid="setting-control-appearance.theme"]').selectOption('github-light');
                await page.locator('[data-testid="settings-close-btn"]').click();
                await expect(modal).toHaveCount(0);
                await expect
                    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
                    .toBe('github-light');
                await captureFrame();

                // Click Switch Revision File to Read-Only: must flush dirty edits and reopen read-only
                await disableEditBtn.click();

                await expect
                    .poll(() => testRepo.getFileContent(parentChangeId, 'parent-file.txt'), { timeout: 15000 })
                    .toContain('toggled editable line');

                await expect(enableEditBtn).toBeVisible({ timeout: 15000 });
                await expect(disableEditBtn).toHaveCount(0);
                await expect(diffViewer.getByRole('textbox')).toHaveCount(0);
                await expect(diffViewer).toContainText('toggled editable line', { timeout: 15000 });
                await expect(
                    page.locator('[data-testid="tab-bar-container"] .tab').filter({ hasText: 'parent-file.txt' }),
                ).toHaveCount(1);

                await page.screenshot({ path: lightReadOnlyPng });
                await captureFrame();
            },
            { outputPath: toggleGifPath },
        );

        expect(pageErrors).toEqual([]);
    });
});
