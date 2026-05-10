/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { buildGraph, TestRepo } from '../test-repo';
import { hoverAndClick, launchVSCode, openFileInEditor } from './e2e-helpers';

test.describe('Quick Diff E2E', () => {
    let repo: TestRepo | undefined;
    let app: ElectronApplication | undefined;
    let userDataDir: string | undefined;

    test.afterEach(async () => {
        if (app) {
            await app.close();
        }
        if (userDataDir) {
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
        }
        if (repo) {
            repo.dispose();
        }
        repo = undefined;
        app = undefined;
        userDataDir = undefined;
    });

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

    async function setupVSCode(testRepo: TestRepo): Promise<Page> {
        const launch = await launchVSCode(testRepo);
        app = launch.app;
        userDataDir = launch.userDataDir;
        return launch.page;
    }

    test('Gutter decorations and Diff Editor refresh after squash', async () => {
        repo = new TestRepo();
        repo.init();

        const fileName = 'squash-hunk-e2e.txt';
        const fileContentOriginal = 'line 1\nline 2\nline 3\n';
        const fileContentModified = 'line 1\nline 2 modified\nline 3\n';

        await buildGraph(repo, [
            {
                label: 'base',
                description: 'base',
                files: { [fileName]: fileContentOriginal },
            },
            {
                label: 'wc',
                parents: ['base'],
                files: { [fileName]: fileContentModified },
            },
        ]);

        const page = await setupVSCode(repo);

        // 1. Open the file
        const editor = await openFileInEditor(page, fileName);

        // 2. Open Gutter Peek View
        const { peekView } = await openGutterPeekView(page, editor);

        // 3. Click Squash Hunk into Parent Button (codicon-repo-pull)
        const squashIcon = peekView.locator('.codicon-repo-pull');
        await expect(squashIcon).toBeVisible({ timeout: 5000 });
        await hoverAndClick(peekView, squashIcon);

        // 4. Verify the change is moved to the parent in JJ
        await expect(async () => {
            if (!repo) {
                throw new Error('Repo not initialized');
            }
            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toBe(fileContentModified);

            const wcContent = repo.getFileContent('@', fileName);
            expect(wcContent).toBe(fileContentModified); // Both same after squash

            const wcDiff = repo.getDiffSummary('@');
            expect(wcDiff).not.toContain(fileName);
        }).toPass({ timeout: 15000 });

        // Peek view should close
        await expect(peekView).not.toBeVisible({ timeout: 5000 });
    });

    test('Discard middle-of-file deletion via gutter peek view', async () => {
        repo = new TestRepo();
        repo.init();

        const fileName = 'middle-deletion-e2e.txt';
        const fileContentOriginal = 'a\nb\nc\nd\ne\n';
        const fileContentModified = 'a\nb\nd\ne\n';

        await buildGraph(repo, [
            {
                label: 'base',
                description: 'base',
                files: { [fileName]: fileContentOriginal },
            },
            {
                label: 'wc',
                parents: ['base'],
                files: { [fileName]: fileContentModified },
            },
        ]);

        const page = await setupVSCode(repo);

        // 1. Open the file via the Explorer
        const editor = await openFileInEditor(page, fileName);

        // 2 & 3. Open Gutter Peek View
        const { peekView } = await openGutterPeekView(page, editor);

        // 4. Click Revert Change Button
        await expect(async () => {
            // Ensure editor has focus as the peek view actions can be focus-dependent
            await editor.focus();

            // Peek view might have multiple action items; be specific.
            const discardIcon = peekView.locator('.codicon-discard');
            await expect(discardIcon).toBeVisible({ timeout: 5000 });
            await hoverAndClick(peekView, discardIcon);

            // 5. Verify file content on disk
            if (!repo) {
                throw new Error('Repo not initialized');
            }
            const filePath = path.join(repo.path, fileName);
            await expect(async () => {
                const content = fs.readFileSync(filePath, 'utf-8');
                if (content !== fileContentOriginal) {
                    throw new Error(`File content mismatch. Expected original content but got: ${content}`);
                }
            }).toPass({ timeout: 20000 });
        }).toPass({ timeout: 30000 });

        // Peek view should close
        await expect(peekView).not.toBeVisible({ timeout: 5000 });
    });

    test('Gutter decorations for a moved file with edits', async () => {
        repo = new TestRepo();
        repo.init();
        repo.config('ui.diff.renames', 'true');

        const oldFileName = 'original.txt';
        const newFileName = 'renamed.txt';
        const originalContent = 'line 1\nline 2\nline 3\nline 4\nline 5\n';

        // 1. Create file in parent
        await buildGraph(repo, [
            {
                label: 'base',
                description: 'base',
                files: { [oldFileName]: originalContent },
            },
        ]);

        // 2. Rename and edit in working copy
        repo.new();
        repo.moveFile(oldFileName, newFileName);
        // Add a line and modify a line
        const modifiedContent = 'line 1\nline 1.5\nline 2 MODIFIED\nline 3\nline 4\nline 5\n';
        repo.writeFile(newFileName, modifiedContent);

        const page = await setupVSCode(repo);

        // 3. Open the renamed file
        const editor = await openFileInEditor(page, newFileName);

        // 4. Open Gutter Peek View
        const { peekView } = await openGutterPeekView(page, editor);

        // 5. Verify diff content in the peek view
        // The original side should show the content from original.txt
        await expect(peekView.locator('.editor.original')).toContainText('line 2', { timeout: 5000 });
        await expect(peekView.locator('.editor.modified')).toContainText('line 2 MODIFIED', { timeout: 5000 });
    });

    test('Squash hunk into parent via gutter peek view', async () => {
        repo = new TestRepo();
        repo.init();

        const fileName = 'squash-hunk-e2e-partial.txt';
        const fileContentOriginal = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
        // Two separate modifications
        const fileContentPartiallyModified = 'line 1\nline 2 modified\nline 3\nline 4\nline 5\n';
        const fileContentFullyModified = 'line 1\nline 2 modified\nline 3\nline 4 modified\nline 5\n';

        await buildGraph(repo, [
            {
                label: 'base',
                description: 'base',
                files: { [fileName]: fileContentOriginal },
            },
            {
                label: 'wc',
                parents: ['base'],
                files: { [fileName]: fileContentFullyModified },
            },
        ]);

        const page = await setupVSCode(repo);

        // 1. Open the file
        const editor = await openFileInEditor(page, fileName);

        // 2. Open Gutter Peek View for the FIRST hunk
        const { peekView } = await openGutterPeekView(page, editor);

        // 3. Click Squash Hunk into Parent Button (codicon-repo-pull)
        const squashIcon = peekView.locator('.codicon-repo-pull');
        await expect(squashIcon).toBeVisible({ timeout: 5000 });
        await hoverAndClick(peekView, squashIcon);

        // 4. Verify the change is moved to the parent in JJ
        await expect(async () => {
            if (!repo) {
                throw new Error('Repo not initialized');
            }
            // Parent should have the first modification but NOT the second
            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toBe(fileContentPartiallyModified);

            // Working copy should still have both modifications
            const wcContent = repo.getFileContent('@', fileName);
            expect(wcContent).toBe(fileContentFullyModified);

            // Working copy diff should still contain the second modification
            const wcDiff = repo.getDiff('@', { git: true });
            expect(wcDiff).toContain('+line 4 modified');
            expect(wcDiff).not.toContain('+line 2 modified');
        }).toPass({ timeout: 15000 });

        // Peek view should close
        await expect(peekView).not.toBeVisible({ timeout: 5000 });
    });
});
