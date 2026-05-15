/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { buildGraph, type CommitId, TestRepo } from '../test-repo';
import {
    clearActiveEditor,
    clickScmAction,
    closeActiveEditor,
    focusSCM,
    launchVSCode,
    SCM_ACTIONS,
    waitForTab,
} from './e2e-helpers';

test.describe('Squash E2E', () => {
    let repo: TestRepo;
    let app: ElectronApplication;
    let page: Page;
    let userDataDir: string;
    let ids: Record<string, CommitId>;

    test.beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent description' },
            { label: 'child', parents: ['parent'], description: 'child description', files: { 'f.txt': 'content' } },
            { label: 'wc', parents: ['child'], isCurrentWorkingCopy: true },
        ]);

        const setup = await launchVSCode(repo);
        app = setup.app;
        page = setup.page;
        userDataDir = setup.userDataDir;
    });

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
    });

    test('Squash: Save and Close', async () => {
        await focusSCM(page);

        // Trigger squash. Since both have descriptions, it should open the editor.
        await clickScmAction(page, /child description/, SCM_ACTIONS.SquashRevisionIntoParent);

        // Wait for SQUASH_MSG tab to open
        await waitForTab(page, 'SQUASH_MSG');

        // Find the editor and modify the text
        const editor = page.locator('.editor-instance .monaco-editor').first();
        await editor.click();
        await clearActiveEditor(page);
        await page.keyboard.insertText('Combined Description');

        // Close the tab to complete the squash
        await closeActiveEditor(page);

        // Handle VS Code's "Save changes?" dialog by clicking Save
        const saveDialog = page.locator('.monaco-dialog-box').filter({ hasText: /Do you want to save the changes/ });
        await expect(saveDialog).toBeVisible();
        await saveDialog.getByRole('button', { name: 'Save', exact: true }).click();

        // Verify the squash is completed in jj
        await expect(async () => {
            const log = repo.log();
            const desc = repo.getDescription(ids.parent.changeId);
            expect(log).not.toContain(ids.child.changeId.substring(0, 8));
            expect(desc).toBe('Combined Description');
        }).toPass({ timeout: 10000 });

        // Verify the tab is closed automatically
        const tab = page.getByRole('tab', { name: 'SQUASH_MSG' });
        await expect(tab).not.toBeVisible({ timeout: 5000 });
    });

    test('Squash: Finalize via checkmark button', async () => {
        await focusSCM(page);

        // Trigger squash
        await clickScmAction(page, /child description/, SCM_ACTIONS.SquashRevisionIntoParent);

        // Wait for SQUASH_MSG tab to open
        await waitForTab(page, 'SQUASH_MSG');

        // Find the editor and modify the text
        const editor = page.locator('.editor-instance .monaco-editor').first();
        await editor.click();
        await clearActiveEditor(page);
        await page.keyboard.insertText('Description via Button');

        // Click the checkmark button in the editor title bar
        const completeButton = page.getByRole('button', { name: 'Complete Squash Revision' }).first();
        await completeButton.click();

        // Verify the squash is completed in jj
        await expect(async () => {
            const log = repo.log();
            expect(log).not.toContain(ids.child.changeId.substring(0, 8));
            const desc = repo.getDescription(ids.parent.changeId);
            expect(desc).toBe('Description via Button');
        }).toPass({ timeout: 10000 });

        // Verify the tab is closed automatically
        const tab = page.getByRole('tab', { name: 'SQUASH_MSG' });
        await expect(tab).not.toBeVisible({ timeout: 5000 });
    });

    test('Squash: Close without saving (unmodified)', async () => {
        await focusSCM(page);

        // Trigger squash
        await clickScmAction(page, /child description/, SCM_ACTIONS.SquashRevisionIntoParent);

        // Wait for SQUASH_MSG tab to open
        await waitForTab(page, 'SQUASH_MSG');

        // Close the tab without modifying it. No VS Code save prompt should appear.
        // This simulates the user just hitting Cmd+W to finish the squash immediately.
        await closeActiveEditor(page);

        // Verify the squash is completed with the original combined description
        await expect(async () => {
            const log = repo.log();
            expect(log).not.toContain(ids.child.changeId.substring(0, 8));
            const desc = repo.getDescription(ids.parent.changeId);
            expect(desc).toBe('parent description\n\nchild description');
        }).toPass({ timeout: 10000 });

        // Verify the tab is closed
        const tab = page.getByRole('tab', { name: 'SQUASH_MSG' });
        await expect(tab).not.toBeVisible();
    });

    test("Squash: Close without saving (modified, click Don't Save)", async () => {
        await focusSCM(page);

        // Trigger squash
        await clickScmAction(page, /child description/, SCM_ACTIONS.SquashRevisionIntoParent);

        // Wait for SQUASH_MSG tab to open
        await waitForTab(page, 'SQUASH_MSG');

        // Find the editor and modify the text
        const editor = page.locator('.editor-instance .monaco-editor').first();
        await editor.click();
        await clearActiveEditor(page);
        await page.keyboard.insertText('Description via Dialog');

        // Close the tab without saving
        await closeActiveEditor(page);

        // Handle VS Code's "Save changes?" dialog
        const saveDialog = page.locator('.monaco-dialog-box').filter({ hasText: /Do you want to save the changes/ });
        await expect(saveDialog).toBeVisible();
        await saveDialog.getByRole('button', { name: "Don't Save" }).click();

        // Verify the squash is completed in jj, but since we didn't save, it uses the original disk contents
        await expect(async () => {
            const log = repo.log();
            expect(log).not.toContain(ids.child.changeId.substring(0, 8));
            const desc = repo.getDescription(ids.parent.changeId);
            expect(desc).toBe('parent description\n\nchild description');
        }).toPass({ timeout: 10000 });

        // Verify the tab is closed
        const tab = page.getByRole('tab', { name: 'SQUASH_MSG' });
        await expect(tab).not.toBeVisible();
    });

    test('Squash: Close without saving (modified, click Cancel)', async () => {
        await focusSCM(page);

        // Trigger squash
        await clickScmAction(page, /child description/, SCM_ACTIONS.SquashRevisionIntoParent);

        // Wait for SQUASH_MSG tab to open
        await waitForTab(page, 'SQUASH_MSG');

        // Modify the text to make it dirty
        const editor = page.locator('.editor-instance .monaco-editor').first();
        await editor.click();
        await clearActiveEditor(page);
        await page.keyboard.insertText('Some text');

        // Close the tab without saving
        await closeActiveEditor(page);

        // Handle VS Code's "Save changes?" dialog
        const saveDialog = page.locator('.monaco-dialog-box').filter({ hasText: /Do you want to save the changes/ });
        await expect(saveDialog).toBeVisible();

        // Click Cancel (or press Escape)
        await page.keyboard.press('Escape');

        // Verify the squash was NOT completed, since the tab is still open
        await expect(async () => {
            const log = repo.log();
            expect(log).toContain('child description');
        }).toPass({ timeout: 5000 });

        // Verify the tab is STILL open because we canceled the close
        const tab = page.getByRole('tab', { name: 'SQUASH_MSG' });
        await expect(tab).toBeVisible();
    });
});
