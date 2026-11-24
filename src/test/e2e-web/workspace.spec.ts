/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestRepo } from '../test-repo';
import { expect, type Page, StandaloneServer, test, waitForScmReady } from './standalone-fixture';

function trackPageErrors(page: Page): string[] {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
        const isExpectedAgentApiUnavailable =
            err.message.includes('agentapi failed') || err.message.includes('agentapi binary not found');
        if (!isExpectedAgentApiUnavailable) {
            pageErrors.push(err.message);
        }
    });
    return pageErrors;
}

test.describe('Standalone Web Workspace Management', () => {
    test('deletes a nested workspace directory via WorkspacePill context menu', async ({ page, server, testRepo }) => {
        const pageErrors = trackPageErrors(page);

        const wsName = 'delete-me';
        const wsPath = path.join(testRepo.path, '.workspaces', wsName);
        testRepo.workspaceAdd(wsName, undefined, wsPath);

        const fullChangeId = testRepo.getLog(`${wsName}@`, 'change_id').trim();
        const shortestChangeId = testRepo.getLog(`${wsName}@`, 'change_id.shortest()').trim();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const pill = page.locator('.workspace-wrapper').filter({ hasText: `${wsName}@` });
        await expect(pill).toBeVisible({ timeout: 10000 });

        await pill.click({ button: 'right' });

        const deleteMenuItem = page.locator('[data-testid="menu-item-jj-view.workspaceDelete"]');
        await expect(deleteMenuItem).toBeVisible();
        await deleteMenuItem.click();

        const toast = page.locator('[data-testid="notification-toast"]');
        await expect(toast).toBeVisible({ timeout: 5000 });
        const message = page.locator('[data-testid="notification-message"]');
        await expect(message).toContainText(`workspace "${wsName}" (change ${shortestChangeId})`);
        await expect(message).not.toContainText(fullChangeId);

        const confirmBtn = page.locator('[data-testid="notification-action-Yes, Delete Workspace"]');
        await expect(confirmBtn).toBeVisible();
        await confirmBtn.click();

        await expect(pill).toHaveCount(0, { timeout: 10000 });
        await expect.poll(() => fs.existsSync(wsPath), { timeout: 10000 }).toBe(false);
        expect(testRepo.listWorkspaces()).not.toContain(wsName);
        expect(pageErrors).toEqual([]);
    });

    test('deletes a sibling workspace directory when server is rooted at a secondary workspace', async ({ page }) => {
        const pageErrors = trackPageErrors(page);

        const mainRepo = new TestRepo();
        let activeRepo: TestRepo | undefined;
        try {
            mainRepo.init();
            const activeWsPath = path.join(mainRepo.path, '.workspaces', 'active-ws');
            const siblingWsPath = path.join(mainRepo.path, '.workspaces', 'sibling-ws');
            activeRepo = mainRepo.workspaceAdd('active-ws', undefined, activeWsPath);
            mainRepo.workspaceAdd('sibling-ws', undefined, siblingWsPath);

            const fullChangeId = mainRepo.getLog('sibling-ws@', 'change_id').trim();
            const shortestChangeId = mainRepo.getLog('sibling-ws@', 'change_id.shortest()').trim();

            const server = new StandaloneServer(activeRepo);
            try {
                await server.start();
                await page.goto(server.serverUrl);
                await waitForScmReady(page);

                const siblingPill = page.locator('.workspace-wrapper').filter({ hasText: 'sibling-ws@' });
                await expect(siblingPill).toBeVisible({ timeout: 10000 });

                await siblingPill.click({ button: 'right' });

                const deleteMenuItem = page.locator('[data-testid="menu-item-jj-view.workspaceDelete"]');
                await expect(deleteMenuItem).toBeVisible();
                await deleteMenuItem.click();

                const message = page.locator('[data-testid="notification-message"]');
                await expect(message).toContainText(`workspace "sibling-ws" (change ${shortestChangeId})`);
                await expect(message).not.toContainText(fullChangeId);

                const confirmBtn = page.locator('[data-testid="notification-action-Yes, Delete Workspace"]');
                await expect(confirmBtn).toBeVisible();
                await confirmBtn.click();

                await expect(siblingPill).toHaveCount(0, { timeout: 10000 });
                await expect.poll(() => fs.existsSync(siblingWsPath), { timeout: 10000 }).toBe(false);
                expect(mainRepo.listWorkspaces()).not.toContain('sibling-ws');
                expect(fs.existsSync(activeWsPath)).toBe(true);
                expect(pageErrors).toEqual([]);
            } finally {
                await server.stop();
            }
        } finally {
            await activeRepo?.dispose();
            await mainRepo.dispose();
        }
    });

    test('forgets a workspace via WorkspacePill context menu without deleting its directory', async ({
        page,
        server,
        testRepo,
    }) => {
        const pageErrors = trackPageErrors(page);

        const wsName = 'forget-me';
        const wsPath = path.join(testRepo.path, '.workspaces', wsName);
        testRepo.workspaceAdd(wsName, undefined, wsPath);

        const fullChangeId = testRepo.getLog(`${wsName}@`, 'change_id').trim();
        const shortestChangeId = testRepo.getLog(`${wsName}@`, 'change_id.shortest()').trim();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const pill = page.locator('.workspace-wrapper').filter({ hasText: `${wsName}@` });
        await expect(pill).toBeVisible({ timeout: 10000 });

        await pill.click({ button: 'right' });

        const forgetMenuItem = page.locator('[data-testid="menu-item-jj-view.workspaceForget"]');
        await expect(forgetMenuItem).toBeVisible();
        await forgetMenuItem.click();

        const message = page.locator('[data-testid="notification-message"]');
        await expect(message).toContainText(`workspace "${wsName}" (change ${shortestChangeId})`);
        await expect(message).not.toContainText(fullChangeId);

        const confirmBtn = page.locator('[data-testid="notification-action-Yes, Forget Workspace"]');
        await expect(confirmBtn).toBeVisible();
        await confirmBtn.click();

        await expect(pill).toHaveCount(0, { timeout: 10000 });
        expect(testRepo.listWorkspaces()).not.toContain(wsName);
        expect(fs.existsSync(wsPath)).toBe(true);
        expect(pageErrors).toEqual([]);
    });
});
