/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildGraph } from '../test-repo';
import { expect, test, waitForScmReady } from './standalone-fixture';

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
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

        // Discard changes via SCM resource action
        await resourceItem.hover();
        const discardBtn = resourceItem.locator('[data-testid="scm-resource-action-jj-view.restore"]');
        await expect(discardBtn).toBeVisible();
        await discardBtn.click();

        // Working copy should now be clean and file restored on disk
        await expect(
            page.locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]'),
        ).toHaveCount(0, { timeout: 5000 });

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
        await conflictItem.click();

        // Verify Diff Viewer is mounted with conflict resolution button
        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

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
        await item.click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible();

        const editor = diffViewer.getByRole('textbox');
        await expect(editor).toBeVisible();
        await editor.click();
        await page.waitForTimeout(200);
        await page.keyboard.type('\nappended edit', { delay: 50 });
        await page.waitForTimeout(200);

        // Save via keyboard shortcut
        await page.keyboard.press('ControlOrMeta+s');

        await expect.poll(() => testRepo.getFileContent('@', 'editable.txt'), { timeout: 5000 }).toContain('edit');
    });
});
