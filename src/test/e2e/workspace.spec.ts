/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { TestRepo, buildGraph } from '../test-repo';
import {
    clickLogTitleButton,
    clickNotificationButton,
    focusJJLog,
    getLogWebview,
    launchVSCode,
    rightClickAndSelect,
    waitForQuickInput,
} from './e2e-helpers';

test.describe('Workspace Management E2E', () => {
    test('Shows workspace labels for multiple workspaces', async () => {
        const repo = new TestRepo();
        repo.init();

        // Setup a repo with two commits
        const nodes = await buildGraph(repo, [
            { label: 'base', description: 'base commit' },
            { label: 'other', description: 'other commit' },
        ]);

        const baseId = nodes['base'].changeId;
        const otherId = nodes['other'].changeId;

        const workspaceName = 'repo2';
        repo.workspaceAdd(workspaceName, baseId);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusJJLog(page);
            const webview = await getLogWebview(page);

            // The default workspace label is 'default@'
            await expect(webview.locator('.bookmark-pill', { hasText: 'default@' })).toBeVisible();

            // The secondary workspace label should match our workspace name
            await expect(webview.locator('.bookmark-pill', { hasText: workspaceName })).toBeVisible();

            // 'default@' should be on the 'other' commit
            const otherRow = webview.locator(`[data-change-id="${otherId}"]`);
            await expect(otherRow.locator('.bookmark-pill', { hasText: 'default@' })).toBeVisible();

            // 'repo2@' should be on its own working copy (created by workspace add)
            const repo2Pill = webview.locator('.bookmark-pill', { hasText: new RegExp(`${workspaceName}.*@`) });
            await expect(repo2Pill).toBeVisible();
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('Add Workspace via title bar action', async () => {
        const repo = new TestRepo();
        repo.init();

        // Use a unique name to avoid any potential (though unlikely) collisions
        const workspaceName = `ws-${Date.now()}`;

        // Enable notifications for this test so we can click "Open Workspace"
        const { app, page, userDataDir } = await launchVSCode(repo, {}, {}, true);

        try {
            await focusJJLog(page);

            // 1. Click Add Workspace in Title Bar
            await clickLogTitleButton(page, 'Add Workspace');

            // 2. Type name and Enter
            const input = await waitForQuickInput(page);
            await input.fill(workspaceName);
            await page.keyboard.press('Enter');

            // 3. Verify workspace pill appears in webview
            const webview = await getLogWebview(page);
            await expect(webview.locator('.bookmark-pill', { hasText: workspaceName })).toBeVisible({ timeout: 20000 });

            // 4. Click "Open Workspace" in the notification and verify a new window opens
            const nextWindowPromise = app.waitForEvent('window');
            await clickNotificationButton(page, 'Open Workspace');
            const newPage = await nextWindowPromise;

            // Wait for workbench to load in new window
            await expect(newPage.locator('.monaco-workbench')).toBeVisible({ timeout: 15000 });

            // On Linux, the window title should contain the folder name
            await expect.poll(async () => await newPage.title(), { timeout: 10000 }).toContain(workspaceName);

            // 5. Verify in jj
            const workspaces = repo.getLog('all()', 'working_copies.map(|w| w.name()).join("\\n")');
            expect(workspaces).toContain(workspaceName);
        } catch (e) {
            throw e;
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('Forget and Delete Workspace via context menu', async () => {
        const repo = new TestRepo();
        repo.init();

        const forgetWs = 'forget-me';
        const deleteWs = 'delete-me';

        // Add both workspaces info the .workspaces directory to match extension default
        const workspacesRelativeDir = '.workspaces';
        repo.workspaceAdd(path.join(workspacesRelativeDir, forgetWs));
        repo.workspaceAdd(path.join(workspacesRelativeDir, deleteWs));

        const forgetWsPath = path.resolve(repo.path, workspacesRelativeDir, forgetWs);
        const deleteWsPath = path.resolve(repo.path, workspacesRelativeDir, deleteWs);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusJJLog(page);
            const webview = await getLogWebview(page);

            // 1. Forget Workspace
            const forgetPill = webview.locator('.bookmark-pill', { hasText: forgetWs });
            await expect(forgetPill).toBeVisible();

            await rightClickAndSelect(page, forgetPill, 'Forget Workspace');

            // Confirm warning dialog
            const forgetBtn = page.getByRole('button', { name: 'Yes, Forget Workspace' });
            await expect(forgetBtn, 'Forget confirmation button should be visible').toBeVisible({ timeout: 5000 });
            await forgetBtn.click();

            await expect(forgetPill).not.toBeVisible({ timeout: 15000 });

            const stillExists = fs.existsSync(forgetWsPath);
            expect(stillExists, `Directory ${forgetWsPath} should still exist after forget`).toBe(true);

            // 2. Delete Workspace
            const deletePill = webview.locator('.bookmark-pill', { hasText: deleteWs });
            await expect(deletePill).toBeVisible();

            await rightClickAndSelect(page, deletePill, 'Delete Workspace Directory');

            // Confirm warning dialog
            const deleteBtn = page.getByRole('button', { name: 'Yes, Delete Workspace' });
            await expect(deleteBtn, 'Delete confirmation button should be visible').toBeVisible({ timeout: 5000 });
            await deleteBtn.click();

            await expect(deletePill).not.toBeVisible({ timeout: 15000 });

            const gone = !fs.existsSync(deleteWsPath);
            expect(gone, `Directory ${deleteWsPath} should be removed after delete`).toBe(true);
        } catch (e) {
            throw e;
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });
});
