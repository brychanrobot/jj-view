/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Status Bar & Notifications', () => {
    test('should render status bar with working copy and connection status', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const statusBar = page.locator('[data-testid="status-bar"]');
        await expect(statusBar).toBeVisible();

        // Check working copy item
        const workingCopyItem = page.locator('[data-testid="status-working-copy"]');
        await expect(workingCopyItem).toBeVisible();
        const wcText = await workingCopyItem.textContent();
        expect(wcText).toBeTruthy();

        // Check connection item
        const connectionItem = page.locator('[data-testid="status-connection"]');
        await expect(connectionItem).toBeVisible();
        await expect(connectionItem).toContainText('Host Connected');

        // Check settings button on status bar opens settings modal
        const settingsBtn = page.locator('[data-testid="status-settings-btn"]');
        await expect(settingsBtn).toBeVisible();
        await settingsBtn.click();

        const settingsModal = page.locator('[data-testid="settings-modal"]');
        await expect(settingsModal).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(settingsModal).toHaveCount(0);
    });

    test('should display status messages and progress in status bar', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Dispatch a status bar message via host UI
        await page.evaluate(() => {
            window.__JJ_VIEW_ENV__?.ui.setStatusBarMessage?.('Absorb completed.', 5000);
        });

        const statusMessage = page.locator('[data-testid="status-message"]');
        await expect(statusMessage).toBeVisible();
        await expect(statusMessage).toContainText('Absorb completed.');

        // Dispatch progress task via host UI
        void page.evaluate(() => {
            void window.__JJ_VIEW_ENV__?.ui.withProgress('Squashing revision...', () => {
                return new Promise((resolve) => setTimeout(resolve, 800));
            });
        });

        const progressItem = page.locator('[data-testid="status-progress"]');
        await expect(progressItem).toBeVisible();
        await expect(progressItem).toContainText('Squashing revision...');

        // Progress finishes and hides
        await expect(progressItem).toHaveCount(0, { timeout: 3000 });
    });

    test('should render notification toasts with actions and resolve user choice', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Initially no toasts
        await expect(page.locator('[data-testid="notification-toast"]')).toHaveCount(0);

        // Show an info notification with actions
        void page.evaluate(() => {
            void window.__JJ_VIEW_ENV__?.ui.showInformation(
                'Workspace created successfully.',
                'Open Workspace',
                'Later',
            );
        });

        const toast = page.locator('[data-testid="notification-toast"]');
        await expect(toast).toBeVisible();
        await expect(toast).toHaveAttribute('data-severity', 'info');

        const msg = page.locator('[data-testid="notification-message"]');
        await expect(msg).toContainText('Workspace created successfully.');

        const openBtn = page.locator('[data-testid="notification-action-Open Workspace"]');
        const laterBtn = page.locator('[data-testid="notification-action-Later"]');
        await expect(openBtn).toBeVisible();
        await expect(laterBtn).toBeVisible();

        // Click an action button
        await openBtn.click();

        // Toast should be dismissed
        await expect(toast).toHaveCount(0);
    });

    test('should support configurable notification position', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const container = page.locator('[data-testid="notification-container"]');

        // Configure position to top-right
        await page.evaluate(() => {
            window.__JJ_VIEW_ENV__?.notifications.setPosition('top-right');
            void window.__JJ_VIEW_ENV__?.ui.showWarning('Attention: Rebasing stack', 'Dismiss');
        });

        await expect(container).toBeVisible();
        await expect(container).toHaveClass(/pos-top-right/);

        const toast = page.locator('[data-testid="notification-toast"]');
        await expect(toast).toBeVisible();
        await expect(toast).toHaveAttribute('data-severity', 'warning');

        // Close with close button
        const closeBtn = page.locator('[data-testid="notification-close-btn"]');
        await closeBtn.click();
        await expect(toast).toHaveCount(0);

        // Reset position back to bottom-right
        await page.evaluate(() => {
            window.__JJ_VIEW_ENV__?.notifications.setPosition('bottom-right');
        });
    });

    test('should capture screenshots and animated GIF of notifications and status flow', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const gifOutputPath = path.join(ARTIFACT_DIR, 'notifications-status-flow.gif');
        const statusOverviewPath = path.join(ARTIFACT_DIR, 'status-bar-overview.png');
        const toastInfoPath = path.join(ARTIFACT_DIR, 'notification-toast-info.png');
        const toastTopRightPath = path.join(ARTIFACT_DIR, 'notification-toast-top-right.png');

        await recordGifFlow(
            page,
            async (capture) => {
                // Frame 0: Clean initial view with status bar
                await capture();
                await page.screenshot({ path: statusOverviewPath });

                // Frame 1: Trigger progress in status bar
                void page.evaluate(() => {
                    void window.__JJ_VIEW_ENV__?.ui.withProgress('Syncing remote repository...', () => {
                        return new Promise((resolve) => setTimeout(resolve, 1500));
                    });
                });
                const progressItem = page.locator('[data-testid="status-progress"]');
                await expect(progressItem).toBeVisible();
                await capture();

                // Frame 2: Trigger toast notification
                void page.evaluate(() => {
                    void window.__JJ_VIEW_ENV__?.ui.showInformation(
                        'Upload succeeded: 2 commits published to remote.',
                        'View on Remote',
                        'Close',
                    );
                });
                const toast = page.locator('[data-testid="notification-toast"]');
                await expect(toast).toBeVisible();
                await capture();
                await page.screenshot({ path: toastInfoPath });

                // Frame 3: Click action button on toast
                const viewBtn = page.locator('[data-testid="notification-action-View on Remote"]');
                await expect(viewBtn).toBeVisible();
                await viewBtn.click();
                await expect(toast).toHaveCount(0);
                await capture();

                // Frame 4: Top-right notification demonstration
                await page.evaluate(() => {
                    window.__JJ_VIEW_ENV__?.notifications.setPosition('top-right');
                    void window.__JJ_VIEW_ENV__?.ui.showWarning('Branch main has diverged.', 'Rebase Stack');
                });
                const topToast = page.locator('[data-testid="notification-toast"]');
                await expect(topToast).toBeVisible();
                await capture();
                await page.screenshot({ path: toastTopRightPath });

                // Dismiss top toast
                await page.locator('[data-testid="notification-close-btn"]').click();
                await expect(topToast).toHaveCount(0);
                await capture();
            },
            { outputPath: gifOutputPath },
        );

        expect(fs.existsSync(gifOutputPath)).toBe(true);
    });
});
