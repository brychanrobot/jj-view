/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { buildGraph } from '../test-repo';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Output Channel & Process Monitor', () => {
    test('should open Output Log from status bar and "Show Log" error toast, highlight & filter logs, and inspect Process & Performance Monitor', async ({
        page,
        server,
        testRepo,
    }) => {
        await buildGraph(testRepo, [
            {
                label: 'base',
                description: 'initial commit',
                files: {
                    'src/index.ts': 'export const app = "jj-view";\n',
                },
                isCurrentWorkingCopy: true,
            },
        ]);

        await recordGifFlow(
            page,
            async (captureFrame) => {
                await page.goto(server.serverUrl);
                await waitForScmReady(page);
                await captureFrame();

                // 1. Click Output Log button in Status Bar
                const outputBtn = page.locator('[data-testid="status-output-btn"]');
                await expect(outputBtn).toBeVisible();
                await outputBtn.click();

                const outputPane = page.locator('[data-testid="output-pane"]');
                await expect(outputPane).toBeVisible({ timeout: 5000 });
                await expect(page.locator('[data-testid="output-log-row"]').first()).toBeVisible({ timeout: 5000 });

                // Verify search filtering highlights matching text
                const filterInput = page.locator('[data-testid="output-filter-input"]');
                await filterInput.fill('Host daemon');
                await expect(page.locator('[data-testid="output-log-row"]')).toHaveCount(1);
                await expect(outputPane.locator('mark.filter-highlight')).toContainText('Host daemon');

                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'output-channel-filtered.png') });
                await captureFrame();

                // Clear filter to show all entries
                await page.locator('[data-testid="output-filter-clear"]').click();
                await expect(filterInput).toHaveValue('');

                // Close Output tab so we can verify "Show Log" toast button re-opens it
                await page.locator('[data-testid="output-close"]').click();
                await expect(outputPane).toHaveCount(0);

                // 2. Trigger an error with a "Show Log" button (e.g., editing immutable root() commit)
                await page.evaluate(() => {
                    const env = window.__JJ_VIEW_ENV__;
                    if (env) {
                        void env.commands.executeCommand('jj-view.edit', { revision: 'root()' });
                    }
                });

                const toastAction = page
                    .locator('[data-testid="notification-toast"] .toast-action-btn')
                    .filter({ hasText: 'Show Log' });
                await expect(toastAction).toBeVisible({ timeout: 5000 });
                await captureFrame();
                await toastAction.click();

                // Clicking "Show Log" must open the Output tab and display the error entry
                await expect(outputPane).toBeVisible({ timeout: 5000 });
                await page.locator('[data-testid="output-level-error"]').click();
                await expect(page.locator('[data-testid="output-log-row"][data-level="error"]').first()).toBeVisible();
                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'output-channel-errors.png') });
                await captureFrame();

                // 3. Open the Process & Performance Monitor via the Status Bar button
                const monitorBtn = page.locator('[data-testid="status-process-monitor-btn"]');
                await expect(monitorBtn).toBeVisible();
                await monitorBtn.click();

                const monitorView = page.locator('[data-testid="process-monitor-view"]');
                await expect(monitorView).toBeVisible({ timeout: 5000 });
                await expect(monitorView).toContainText('Process & Performance Monitor');
                await expect(monitorView).toContainText('Running Processes');
                await expect(monitorView).toContainText('History');

                // Verify that real jj CLI invocations were recorded in History
                const historyRows = monitorView.locator('.tasks-table tbody tr.task-row');
                await expect(historyRows.first()).toBeVisible({ timeout: 5000 });

                // Expand the first history row to inspect command & stdout details
                await historyRows.first().click();
                await expect(monitorView.locator('.detail-row').first()).toBeVisible();

                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'process-monitor-view.png') });
                await captureFrame();
            },
            { outputPath: path.join(ARTIFACT_DIR, 'output-and-monitor-flow.gif') },
        );
    });
});
