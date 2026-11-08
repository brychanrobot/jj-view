/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {
    ARTIFACT_DIR,
    expect,
    recordGifFlow,
    recordInteractionFlow,
    StandaloneServer,
    test,
    waitForScmReady,
} from './standalone-fixture';

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

    test('should advertise available release in status bar, toast, and command palette and self-update in-place', async ({
        page,
        testRepo,
    }) => {
        const isWin = process.platform === 'win32';
        const binaryName = isWin ? 'jj-view.exe' : 'jj-view';
        const releaseAssetName = isWin ? 'jj-view-windows-amd64.exe' : 'jj-view-linux-amd64';
        const sourceBinaryPath = path.resolve(__dirname, '../../../dist/bin', binaryName);
        const binaryBytes = fs.readFileSync(sourceBinaryPath);
        const sha256Hex = crypto.createHash('sha256').update(binaryBytes).digest('hex');
        const checksumsText = `${sha256Hex}  ${releaseAssetName}\n`;
        const checksumsBytes = Buffer.from(checksumsText, 'utf-8');

        let releaseRequests = 0;
        let checksumDownloads = 0;
        let binaryDownloads = 0;
        let mockPort = 0;

        const mockReleaseServer = http.createServer((req, res) => {
            const reqUrl = req.url ?? '/';
            if (reqUrl.startsWith('/releases')) {
                releaseRequests++;
                const activeTag = binaryDownloads > 0 ? 'v3.0.0' : 'v99.0.0';
                const payload = [
                    {
                        tag_name: activeTag,
                        name: `JJ View ${activeTag}`,
                        prerelease: false,
                        draft: false,
                        html_url: `http://127.0.0.1:${mockPort}/release-notes`,
                        body: '### Release Highlights\n- Zero-downtime Web & CLI self-update',
                        published_at: '2026-11-08T12:00:00Z',
                        assets: [
                            {
                                name: releaseAssetName,
                                browser_download_url: `http://127.0.0.1:${mockPort}/download/${releaseAssetName}`,
                                size: binaryBytes.length,
                            },
                            {
                                name: 'checksums.txt',
                                browser_download_url: `http://127.0.0.1:${mockPort}/download/checksums.txt`,
                                size: checksumsBytes.length,
                            },
                        ],
                    },
                ];
                const body = JSON.stringify(payload);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Content-Length': String(Buffer.byteLength(body)),
                });
                res.end(body);
                return;
            }

            if (reqUrl === '/download/checksums.txt') {
                checksumDownloads++;
                res.writeHead(200, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Content-Length': String(checksumsBytes.length),
                });
                res.end(checksumsBytes);
                return;
            }

            if (reqUrl === `/download/${releaseAssetName}`) {
                binaryDownloads++;
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': String(binaryBytes.length),
                });
                res.end(binaryBytes);
                return;
            }

            res.writeHead(404);
            res.end('Not found');
        });

        await new Promise<void>((resolve, reject) => {
            mockReleaseServer.once('error', reject);
            mockReleaseServer.listen(0, '127.0.0.1', () => {
                const addr = mockReleaseServer.address();
                if (addr && typeof addr === 'object') {
                    mockPort = addr.port;
                    resolve();
                } else {
                    reject(new Error('Failed to bind mock release server'));
                }
            });
        });

        const isolatedServer = new StandaloneServer(testRepo, {
            copyBinaryToTemp: true,
            env: {
                JJ_VIEW_UPDATE_URL: `http://127.0.0.1:${mockPort}/releases`,
                JJ_VIEW_RELEASE_ASSET: releaseAssetName,
            },
        });

        const gifPath = path.join(ARTIFACT_DIR, 'self-update-flow.gif');
        const mp4Path = path.join(ARTIFACT_DIR, 'self-update-flow.mp4');
        const darkShotPath = path.join(ARTIFACT_DIR, 'self-update-available-dark.png');
        const lightShotPath = path.join(ARTIFACT_DIR, 'self-update-available-light.png');
        const paletteShotPath = path.join(ARTIFACT_DIR, 'self-update-command-palette.png');
        const completedShotPath = path.join(ARTIFACT_DIR, 'self-update-completed.png');

        try {
            await isolatedServer.start();
            await page.goto(isolatedServer.serverUrl);
            await waitForScmReady(page);

            await recordInteractionFlow(
                page,
                {
                    gifPath,
                    mp4Path,
                    fps: 24,
                    scale: 1280,
                },
                async (rec) => {
                    await page.evaluate(() => {
                        const hud = document.getElementById('jj-interaction-hud');
                        if (hud) {
                            hud.style.bottom = 'auto';
                            hud.style.top = '16px';
                            hud.style.right = '24px';
                        }
                    });
                    await rec.setHud('1/4 — Startup Update Check (v99.0.0 Available)');
                    const updateBtn = page.locator('[data-testid="status-update-btn"]');
                    await expect(updateBtn).toBeVisible({ timeout: 10000 });
                    await expect(updateBtn).toContainText('Update to v99.0.0');

                    const toast = page.locator('[data-testid="notification-toast"]');
                    await expect(toast).toBeVisible();
                    await expect(toast).toContainText('JJ View v99.0.0 is available');
                    await expect(page.locator('[data-testid="notification-action-Update & Restart"]')).toBeVisible();
                    await expect(page.locator('[data-testid="notification-action-Release Notes"]')).toBeVisible();
                    expect(releaseRequests).toBeGreaterThanOrEqual(1);

                    await rec.moveTo(page.locator('[data-testid="notification-action-Update & Restart"]'), 16);
                    await rec.hover(10);
                    await page.screenshot({ path: darkShotPath });

                    // Verify light theme rendering of update pill & toast
                    await page.evaluate(async () => {
                        await window.__JJ_VIEW_ENV__?.config.update?.('appearance.theme', 'pierre-light');
                    });
                    await expect(page.locator('html')).toHaveAttribute('data-theme', 'pierre-light');
                    await page.screenshot({ path: lightShotPath });

                    await page.evaluate(async () => {
                        await window.__JJ_VIEW_ENV__?.config.update?.('appearance.theme', 'pierre-dark-soft');
                    });
                    await expect(page.locator('html')).toHaveAttribute('data-theme', 'pierre-dark-soft');

                    // Open Command Palette and verify update commands
                    await rec.setHud('2/4 — Command Palette Update Actions');
                    await page.keyboard.press('F1');
                    const quickInput = page.locator('[data-testid="quick-input-widget"]');
                    await expect(quickInput).toBeVisible();
                    await page.keyboard.type('Update');

                    const installPaletteItem = quickInput.locator('[data-testid^="quick-pick-item-"]', {
                        hasText: 'Update to v99.0.0',
                    });
                    const checkPaletteItem = quickInput.locator('[data-testid^="quick-pick-item-"]', {
                        hasText: 'Check for Updates',
                    });
                    await expect(installPaletteItem).toBeVisible();
                    await expect(checkPaletteItem).toBeVisible();
                    await rec.moveTo(installPaletteItem, 14);
                    await rec.hover(10);
                    await page.screenshot({ path: paletteShotPath });
                    await page.keyboard.press('Escape');
                    await expect(quickInput).toHaveCount(0);

                    // Click Status Bar update button to apply update & trigger SIGHUP reload
                    await rec.setHud('3/4 — Applying Update & In-Place Daemon Reload');
                    await rec.click(updateBtn, 5);

                    await expect.poll(() => checksumDownloads, { timeout: 10000 }).toBe(1);
                    await expect.poll(() => binaryDownloads, { timeout: 10000 }).toBe(1);

                    // Wait for SIGHUP reload + reconnect + fresh startup check against v3.0.0
                    await rec.setHud('4/4 — Daemon Reloaded & Up-to-Date');
                    await expect(page.locator('[data-testid="status-connection"]')).toContainText('Host Connected', {
                        timeout: 15000,
                    });
                    await expect(page.locator('[data-testid="status-update-btn"]')).toHaveCount(0, {
                        timeout: 15000,
                    });
                    await rec.hover(12);
                    await page.screenshot({ path: completedShotPath });
                },
            );

            expect(fs.existsSync(gifPath)).toBe(true);
            expect(fs.existsSync(mp4Path)).toBe(true);
            expect(fs.existsSync(darkShotPath)).toBe(true);
            expect(fs.existsSync(lightShotPath)).toBe(true);
            expect(fs.existsSync(paletteShotPath)).toBe(true);
            expect(fs.existsSync(completedShotPath)).toBe(true);
        } finally {
            await isolatedServer.stop();
            await new Promise<void>((resolve) => {
                mockReleaseServer.close(() => resolve());
            });
        }
    });
});
