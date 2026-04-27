/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { focusSCM, launchVSCode, openFileInEditor } from './e2e-helpers';

test.describe('Quick Diff E2E', () => {
    async function openGutterPeekView(page: Page, editor: Locator): Promise<{ peekView: Locator; gutter: Locator }> {
        const gutter = editor.locator('[title="Added lines"], [title="Changed lines"], [title="Removed lines"]');
        await expect(gutter.first()).toBeVisible({ timeout: 15000 });

        const peekView = page.locator('.monaco-editor .zone-widget');
        await expect(async () => {
            await editor.click();
            const target = gutter.first();
            const box = await target.boundingBox();
            if (box) {
                await page.mouse.click(box.x + 1, box.y + box.height / 2, { delay: 100 });
            }
            await expect(peekView).toBeVisible({ timeout: 5000 });
        }).toPass({ timeout: 20000 });

        return { peekView, gutter };
    }

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
            const editor = await openFileInEditor(page, fileName);

            // 2 & 3. Open Gutter Peek View
            const { peekView, gutter } = await openGutterPeekView(page, editor);

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

    test('Discard middle-of-file deletion via gutter peek view', async () => {
        const repo = new TestRepo();
        repo.init();

        const fileName = 'middle-deletion-e2e.txt';
        const fileContentOriginal = 'a\nb\nc\nd\ne\n';
        const fileContentModified = 'a\nb\nd\ne\n';

        repo.writeFile(fileName, fileContentOriginal);
        repo.describe('base');
        repo.new();
        repo.writeFile(fileName, fileContentModified);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            // 1. Open the file via the Explorer
            const editor = await openFileInEditor(page, fileName);

            // 2 & 3. Open Gutter Peek View
            const { peekView } = await openGutterPeekView(page, editor);

            // 4. Click Revert Change Button
            const revertButton = peekView.locator('[aria-label="Discard Change"]');
            await expect(revertButton).toBeVisible({ timeout: 5000 });
            await revertButton.click();

            // 5. Verify file content on disk
            const filePath = path.join(repo.path, fileName);
            await expect(async () => {
                const content = fs.readFileSync(filePath, 'utf-8');
                expect(content).toBe(fileContentOriginal);
            }).toPass({ timeout: 10000 });

            // Peek view should close
            await expect(peekView).not.toBeVisible({ timeout: 5000 });
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });
});
