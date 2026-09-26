/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Commit Highlighting', () => {
    test('should highlight target commit in JJ Log via HostNavigation.highlightCommit', async ({
        page,
        server,
        testRepo,
    }) => {
        // Prepare commits
        testRepo.writeFile('file1.txt', 'commit 1\n');
        testRepo.describe('feat: initial base commit');
        testRepo.new();

        testRepo.writeFile('file2.txt', 'commit 2\n');
        testRepo.describe('feat: target commit to highlight');
        testRepo.new();

        testRepo.writeFile('file3.txt', 'commit 3\n');
        testRepo.describe('feat: current working commit');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logPane = page.locator('[data-testid="log-pane"]');
        await expect(logPane).toBeVisible({ timeout: 10000 });

        const logContent = page.locator('[data-testid="log-content"]');
        await expect(logContent).toBeVisible();

        const commitRows = logContent.locator('.commit-row');
        await expect(commitRows.first()).toBeVisible({ timeout: 10000 });
        await expect(commitRows).toHaveCount(4);

        const targetRow = logContent.locator('.commit-row').filter({ hasText: 'feat: target commit to highlight' });
        await expect(targetRow).toBeVisible();

        const changeId = await targetRow.getAttribute('data-change-id');
        expect(changeId).toBeTruthy();

        // 1. Verify initially no row has data-highlighted="true"
        await expect(logContent.locator('.commit-row[data-highlighted="true"]')).toHaveCount(0);

        // 2. Trigger highlightCommit on HostNavigation
        await page.evaluate((targetId) => {
            const env = window.__JJ_VIEW_ENV__;
            if (env?.workspace.workspaceFolders?.[0]?.uri && targetId) {
                env.nav.highlightCommit?.(env.workspace.workspaceFolders[0].uri, targetId);
            }
        }, changeId);

        // 3. Verify targetRow is highlighted
        await expect(targetRow).toHaveAttribute('data-highlighted', 'true', { timeout: 5000 });
        await expect(logContent.locator('.commit-row[data-highlighted="true"]')).toHaveCount(1);

        // 4. Clear highlight with undefined
        await page.evaluate(() => {
            const env = window.__JJ_VIEW_ENV__;
            if (env?.workspace.workspaceFolders?.[0]?.uri) {
                env.nav.highlightCommit?.(env.workspace.workspaceFolders[0].uri, undefined);
            }
        });

        // 5. Verify highlight is removed
        await expect(targetRow).toHaveAttribute('data-highlighted', 'false', { timeout: 5000 });
        await expect(logContent.locator('.commit-row[data-highlighted="true"]')).toHaveCount(0);
    });

    test('should visually capture quick-pick commit navigation and animated flow', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('feature-a.txt', 'Feature A\n');
        testRepo.describe('feat: add core protocol service');
        testRepo.new();

        testRepo.writeFile('feature-b.txt', 'Feature B\n');
        testRepo.describe('feat: implement commit highlighting');
        testRepo.new();

        testRepo.writeFile('feature-c.txt', 'Feature C\n');
        testRepo.describe('feat: active working copy');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logPane = page.locator('[data-testid="log-pane"]');
        await expect(logPane).toBeVisible({ timeout: 10000 });

        const logContent = page.locator('[data-testid="log-content"]');
        const commitRows = logContent.locator('.commit-row');
        await expect(commitRows.first()).toBeVisible({ timeout: 10000 });

        const targetRow = logContent.locator('.commit-row').filter({ hasText: 'feat: implement commit highlighting' });
        await expect(targetRow).toBeVisible();
        const targetChangeId = (await targetRow.getAttribute('data-change-id')) ?? '';
        expect(targetChangeId).not.toBe('');

        const baseRow = logContent.locator('.commit-row').filter({ hasText: 'feat: add core protocol service' });
        await expect(baseRow).toBeVisible();
        const baseChangeId = (await baseRow.getAttribute('data-change-id')) ?? '';
        expect(baseChangeId).not.toBe('');

        const gifPath = path.join(ARTIFACT_DIR, 'commit-highlight-flow.gif');
        const activePngPath = path.join(ARTIFACT_DIR, 'commit-highlight-active.png');
        const clearPngPath = path.join(ARTIFACT_DIR, 'commit-highlight-clear.png');

        await recordGifFlow(
            page,
            async (captureFrame) => {
                // Frame 1: Initial state
                await captureFrame();

                // Open quick-pick simulating revision selection with active highlight tracking
                void page.evaluate(
                    ({ baseId, targetId }) => {
                        const env = window.__JJ_VIEW_ENV__;
                        if (!env) {
                            return;
                        }
                        const items = [
                            {
                                label: 'feat: add core protocol service',
                                description: baseId,
                                changeId: baseId,
                            },
                            {
                                label: 'feat: implement commit highlighting',
                                description: targetId,
                                changeId: targetId,
                            },
                        ];

                        void env.ui.showQuickPick(items, {
                            title: 'Squash into revision',
                            placeHolder: 'Select destination revision to highlight and squash',
                            onDidChangeActive: (activeItems: readonly { label: string; changeId?: string }[]) => {
                                const active = activeItems[0];
                                const folderUri = env.workspace.workspaceFolders?.[0]?.uri;
                                if (folderUri) {
                                    env.nav.highlightCommit?.(folderUri, active?.changeId);
                                }
                            },
                        });
                    },
                    { baseId: baseChangeId, targetId: targetChangeId },
                );

                const quickInput = page.locator('[data-testid="quick-input-widget"]');
                await expect(quickInput).toBeVisible({ timeout: 5000 });
                const quickPickItems = page.locator('.quick-pick-item');
                await expect(quickPickItems).toHaveCount(2);

                // Frame 2: First item active & highlighted in log
                await expect(baseRow).toHaveAttribute('data-highlighted', 'true', { timeout: 5000 });
                await captureFrame();

                // Move selection down to second item (target commit)
                await page.keyboard.press('ArrowDown');
                await expect(targetRow).toHaveAttribute('data-highlighted', 'true', { timeout: 5000 });
                await expect(baseRow).toHaveAttribute('data-highlighted', 'false', { timeout: 5000 });

                // Capture high-res screenshot of active highlighted commit
                await page.screenshot({ path: activePngPath });
                // Frame 3: Target commit highlighted
                await captureFrame();

                // Dismiss quick pick with Escape
                await page.keyboard.press('Escape');
                await expect(quickInput).toHaveCount(0, { timeout: 5000 });

                // Clear highlight
                await page.evaluate(() => {
                    const env = window.__JJ_VIEW_ENV__;
                    const folderUri = env?.workspace.workspaceFolders?.[0]?.uri;
                    if (env && folderUri) {
                        env.nav.highlightCommit?.(folderUri, undefined);
                    }
                });

                await expect(targetRow).toHaveAttribute('data-highlighted', 'false', { timeout: 5000 });
                // Capture high-res screenshot of cleared highlight
                await page.screenshot({ path: clearPngPath });
                // Frame 4: Cleared state
                await captureFrame();
            },
            { outputPath: gifPath, framerate: 1.2 },
        );

        expect(fs.existsSync(gifPath)).toBe(true);
        expect(fs.existsSync(activePngPath)).toBe(true);
        expect(fs.existsSync(clearPngPath)).toBe(true);
    });
});
