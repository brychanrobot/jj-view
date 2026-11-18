/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestRepo } from '../test-repo';
import { ARTIFACT_DIR, expect, StandaloneServer, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Log Empty & Error States', () => {
    test('displays empty state when workspace has no jj repository across dark and light themes', async ({ page }) => {
        const emptyDirRepo = new TestRepo();
        const server = new StandaloneServer(emptyDirRepo);

        try {
            await server.start();
            await page.goto(server.serverUrl);
            await waitForScmReady(page);

            const logPane = page.locator('[data-testid="log-pane"]');
            await expect(logPane).toBeVisible({ timeout: 10000 });

            const noRepoState = page.locator('[data-testid="log-no-repo-state"]');
            await expect(noRepoState).toBeVisible({ timeout: 10000 });
            await expect(noRepoState).toContainText('No Jujutsu repository found in this workspace.');
            await expect(logPane.locator('.loading-state')).toHaveCount(0);
            await expect(logPane.locator('.commit-graph')).toHaveCount(0);
            await expect(logPane.locator('[data-testid="log-error-state"]')).toHaveCount(0);

            // Log pane auto-sizes to fit the empty state cleanly (header 35px + empty state)
            const paneBox = await logPane.boundingBox();
            const stateBox = await noRepoState.boundingBox();
            expect(paneBox).not.toBeNull();
            expect(stateBox).not.toBeNull();
            if (paneBox && stateBox) {
                expect(paneBox.height).toBeGreaterThan(80);
                expect(stateBox.y + stateBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 2);
            }

            // Dark theme verification (default pierre-dark-soft)
            const titleEl = noRepoState.locator('.log-status-title');
            const darkColors = await page.evaluate(() => {
                const pane = document.querySelector('[data-testid="log-pane"]');
                const title = document.querySelector('[data-testid="log-no-repo-state"] .log-status-title');
                return {
                    paneBg: pane ? getComputedStyle(pane).backgroundColor : '',
                    titleColor: title ? getComputedStyle(title).color : '',
                };
            });
            expect(darkColors.paneBg).not.toBe('');
            expect(darkColors.titleColor).not.toBe('');
            expect(darkColors.paneBg).not.toBe(darkColors.titleColor);
            await expect(titleEl).toBeVisible();
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'log-no-repo-dark.png') });

            // Light theme verification (pierre-light)
            await page.evaluate(async () => {
                await window.__JJ_VIEW_ENV__?.config.update?.('appearance.theme', 'pierre-light');
            });
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'pierre-light');
            await expect
                .poll(async () => {
                    return await page.evaluate(() => {
                        const pane = document.querySelector('[data-testid="log-pane"]');
                        const title = document.querySelector('[data-testid="log-no-repo-state"] .log-status-title');
                        return {
                            paneBg: pane ? getComputedStyle(pane).backgroundColor : '',
                            titleColor: title ? getComputedStyle(title).color : '',
                        };
                    });
                })
                .not.toEqual(darkColors);

            const lightColors = await page.evaluate(() => {
                const pane = document.querySelector('[data-testid="log-pane"]');
                const title = document.querySelector('[data-testid="log-no-repo-state"] .log-status-title');
                return {
                    paneBg: pane ? getComputedStyle(pane).backgroundColor : '',
                    titleColor: title ? getComputedStyle(title).color : '',
                };
            });
            expect(lightColors.paneBg).not.toBe(lightColors.titleColor);
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'log-no-repo-light.png') });
        } finally {
            await server.stop();
            await emptyDirRepo.dispose();
        }
    });

    test('displays error state when jj log fails and recovers when repository is repaired', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('hello.txt', 'hello\n');
        testRepo.describe('feat: recovered commit');

        const storeTypePath = path.join(testRepo.path, '.jj', 'repo', 'store', 'type');
        const originalStoreType = fs.readFileSync(storeTypePath, 'utf-8');
        fs.writeFileSync(storeTypePath, 'corrupt', 'utf-8');

        try {
            await page.goto(server.serverUrl);
            await waitForScmReady(page);

            const logPane = page.locator('[data-testid="log-pane"]');
            const errorState = page.locator('[data-testid="log-error-state"]');
            await expect(errorState).toBeVisible({ timeout: 10000 });
            await expect(errorState).toContainText('Unable to load Jujutsu log');
            await expect(errorState.locator('.log-status-detail')).toContainText('corrupt');
            await expect(logPane.locator('.loading-state')).toHaveCount(0);
            await expect(logPane.locator('.commit-graph')).toHaveCount(0);

            // Dark theme verification
            const darkColors = await page.evaluate(() => {
                const pane = document.querySelector('[data-testid="log-pane"]');
                const title = document.querySelector('[data-testid="log-error-state"] .log-status-title');
                return {
                    paneBg: pane ? getComputedStyle(pane).backgroundColor : '',
                    titleColor: title ? getComputedStyle(title).color : '',
                };
            });
            expect(darkColors.paneBg).not.toBe('');
            expect(darkColors.titleColor).not.toBe('');
            expect(darkColors.paneBg).not.toBe(darkColors.titleColor);
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'log-error-dark.png') });

            // Light theme verification
            await page.evaluate(async () => {
                await window.__JJ_VIEW_ENV__?.config.update?.('appearance.theme', 'pierre-light');
            });
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'pierre-light');
            await expect
                .poll(async () => {
                    return await page.evaluate(() => {
                        const pane = document.querySelector('[data-testid="log-pane"]');
                        const title = document.querySelector('[data-testid="log-error-state"] .log-status-title');
                        return {
                            paneBg: pane ? getComputedStyle(pane).backgroundColor : '',
                            titleColor: title ? getComputedStyle(title).color : '',
                        };
                    });
                })
                .not.toEqual(darkColors);

            const lightColors = await page.evaluate(() => {
                const pane = document.querySelector('[data-testid="log-pane"]');
                const title = document.querySelector('[data-testid="log-error-state"] .log-status-title');
                return {
                    paneBg: pane ? getComputedStyle(pane).backgroundColor : '',
                    titleColor: title ? getComputedStyle(title).color : '',
                };
            });
            expect(lightColors.paneBg).not.toBe(lightColors.titleColor);
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'log-error-light.png') });

            // Constrained height verification: status-scroll-container remains scrollable
            const scrollContainer = logPane.locator('.status-scroll-container');
            await expect(scrollContainer).toHaveCount(1);
            const originalViewport = page.viewportSize();
            try {
                await page.setViewportSize({ width: 1280, height: 220 });
                await expect
                    .poll(async () => {
                        return await scrollContainer.evaluate(
                            (el) => el.clientHeight > 10 && el.scrollHeight > el.clientHeight,
                        );
                    })
                    .toBe(true);
                const scrollTop = await scrollContainer.evaluate((el) => {
                    el.scrollTop = 40;
                    return el.scrollTop;
                });
                expect(scrollTop).toBeGreaterThan(0);
            } finally {
                if (originalViewport) {
                    await page.setViewportSize(originalViewport);
                }
            }

            // Repair repository store type and trigger refresh -> recovers to commit graph
            fs.writeFileSync(storeTypePath, originalStoreType, 'utf-8');
            await page.evaluate(async () => {
                await window.__JJ_VIEW_ENV__?.commands.executeCommand('jj-view.refreshGraph');
            });

            await expect(errorState).toHaveCount(0, { timeout: 10000 });
            await expect(logPane.locator('.commit-row').filter({ hasText: 'feat: recovered commit' })).toBeVisible({
                timeout: 10000,
            });
        } finally {
            if (fs.existsSync(path.dirname(storeTypePath))) {
                fs.writeFileSync(storeTypePath, originalStoreType, 'utf-8');
            }
        }
    });
});
