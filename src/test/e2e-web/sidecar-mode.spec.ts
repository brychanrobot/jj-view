/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Antigravity UI Sidecar Mode & Adaptive Auxiliary Layout', () => {
    test('should adapt layout to Auxiliary Pane with mode switcher pills when viewport is narrow (< 500px)', async ({
        page,
        server,
        testRepo,
    }) => {
        // Set viewport size to 380px (typical IDE auxiliary pane width)
        await page.setViewportSize({ width: 380, height: 720 });

        testRepo.writeFile('welcome.txt', 'welcome to sidecar mode\n');
        testRepo.describe('initial sidecar commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Verify narrow switcher pill bar is visible
        const switcher = page.locator('[data-testid="narrow-switcher"]');
        await expect(switcher).toBeVisible();

        const pillChanges = page.locator('[data-testid="pill-changes"]');
        const pillLog = page.locator('[data-testid="pill-log"]');
        const pillDiff = page.locator('[data-testid="pill-diff"]');

        await expect(pillChanges).toBeVisible();
        await expect(pillLog).toBeVisible();
        await expect(pillDiff).toBeVisible();

        // By default, Changes is active
        await expect(pillChanges).toHaveClass(/active/);

        // Switch to Log
        await pillLog.click();
        await expect(pillLog).toHaveClass(/active/);
        await expect(pillChanges).not.toHaveClass(/active/);

        // Switch to Diff
        await pillDiff.click();
        await expect(pillDiff).toHaveClass(/active/);

        // Switch back to Changes
        await pillChanges.click();
        await expect(pillChanges).toHaveClass(/active/);

        // Capture screenshot of narrow auxiliary pane layout
        await page.screenshot({
            path: path.join(ARTIFACT_DIR, 'sidecar-aux-pane-narrow.png'),
        });
    });

    test('should auto-switch to Diff pill and force unified diff mode when opening a file in narrow layout', async ({
        page,
        server,
        testRepo,
    }) => {
        await page.setViewportSize({ width: 380, height: 720 });

        testRepo.writeFile('feature.txt', 'const mode = "standalone";\n');
        testRepo.describe('feature base');
        testRepo.new();

        testRepo.writeFile('feature.txt', 'const mode = "sidecar";\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const pillChanges = page.locator('[data-testid="pill-changes"]');
        const pillDiff = page.locator('[data-testid="pill-diff"]');
        await expect(pillChanges).toHaveClass(/active/);

        // Click modified file
        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'feature.txt' });
        await expect(item).toBeVisible();
        await item.click();

        // Should automatically switch to Diff pill
        await expect(pillDiff).toHaveClass(/active/);

        // Verify PierreDiffViewer is mounted
        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible();

        // Unified button should be active due to narrow container (< 600px)
        const unifiedBtn = page.locator('button[data-style="unified"]');
        await expect(unifiedBtn).toBeVisible();
        await expect(unifiedBtn).toHaveClass(/active/);

        await page.screenshot({
            path: path.join(ARTIFACT_DIR, 'sidecar-diff-unified-auto.png'),
        });
    });

    test('should render agent draft button and populate commit message when sidecar is available', async ({
        page,
        server,
        testRepo,
    }) => {
        await page.setViewportSize({ width: 420, height: 720 });

        // Mock window.sidecar bridge
        await page.addInitScript(() => {
            Object.defineProperty(window, 'sidecar', {
                value: {
                    getWorkspaceUris: async () => [],
                    onWorkspaceChange: () => () => {},
                    agent: {
                        sendMessage: async () => ({
                            messageId: 'agent-msg-1',
                            status: 'delivered',
                            response: 'feat(sidecar): integrate Antigravity auxiliary pane support',
                        }),
                        startConversation: async () => ({ conversationId: 'c-1' }),
                        getConversationMetadata: async () => ({ conversationId: 'c-1' }),
                    },
                },
                writable: true,
                configurable: true,
            });
        });

        testRepo.writeFile('sidecar.ts', 'export const sidecar = true;\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Check agent draft sparkle button is rendered
        const agentButton = page.locator('[data-testid="agent-draft-button"]');
        await expect(agentButton).toBeVisible();

        // Record animated GIF flow of clicking sparkle button and populating description
        await recordGifFlow(
            page,
            async (captureFrame) => {
                await captureFrame();
                await agentButton.click();
                await captureFrame();
                const textarea = page.locator('[data-testid="scm-input-textarea"]');
                await expect(textarea).toHaveValue('feat(sidecar): integrate Antigravity auxiliary pane support');
                await captureFrame();
            },
            {
                outputPath: path.join(ARTIFACT_DIR, 'sidecar-agent-draft-flow.gif'),
                framerate: 1.5,
            },
        );

        const textarea = page.locator('[data-testid="scm-input-textarea"]');
        await expect(textarea).toHaveValue('feat(sidecar): integrate Antigravity auxiliary pane support');

        await page.screenshot({
            path: path.join(ARTIFACT_DIR, 'sidecar-agent-drafted-message.png'),
        });
    });

    test('should open Add Selection to Chat prompt on Ctrl+L in diff viewer and send context to sidecar agent', async ({
        page,
        server,
        testRepo,
    }) => {
        await page.setViewportSize({ width: 1100, height: 760 });

        await page.addInitScript(() => {
            const sentMessages: string[] = [];
            Object.defineProperty(window, '__sentSidecarMessages', {
                value: sentMessages,
                writable: true,
                configurable: true,
            });
            Object.defineProperty(window, 'sidecar', {
                value: {
                    getWorkspaceUris: async () => [],
                    onWorkspaceChange: () => () => {},
                    agent: {
                        sendMessage: async (message: string) => {
                            sentMessages.push(message);
                            return {
                                messageId: 'agent-msg-ctx-1',
                                status: 'delivered',
                            };
                        },
                        startConversation: async () => ({ conversationId: 'c-1' }),
                        getConversationMetadata: async () => ({ conversationId: 'c-1' }),
                    },
                },
                writable: true,
                configurable: true,
            });
        });

        testRepo.writeFile('calc.ts', 'export function add(a: number, b: number): number {\n    return a + b;\n}\n');
        testRepo.describe('initial calc');
        testRepo.new();
        testRepo.writeFile(
            'calc.ts',
            'export function add(a: number, b: number): number {\n    const sum = a + b;\n    return sum;\n}\n',
        );

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'calc.ts' });
        await expect(item).toBeVisible();
        await item.click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible();

        // Click a line number in the additions gutter inside Pierre's shadow DOM
        const gutterLineNumber = diffViewer.locator('[data-additions] [data-column-number="2"]').first();
        await expect(gutterLineNumber).toBeVisible();
        await gutterLineNumber.click();

        // Press Ctrl+L to trigger Add Selection to Chat
        await page.keyboard.press('Control+l');

        const quickInput = page.locator('[data-testid="quick-input-widget"]');
        await expect(quickInput).toBeVisible();
        await expect(page.locator('[data-testid="quick-input-context-badge"]')).toContainText('calc.ts:2');
        await expect(page.locator('[data-testid="quick-input-context-snippet"]')).toContainText('const sum = a + b;');

        const input = page.locator('[data-testid="quick-input-text-input"]');
        await input.fill('Explain why sum was extracted');
        await input.press('Enter');

        await expect(quickInput).toBeHidden();
        await expect(page.locator('[data-testid="notification-toast"][data-severity="info"]')).toContainText(
            'Sent calc.ts:2 to chat.',
        );
        await expect(page.locator('[data-testid="notification-toast"][data-severity="error"]')).toHaveCount(0);

        const sentMessages = await page.evaluate(() => {
            const win = window as Window & { __sentSidecarMessages?: string[] };
            return win.__sentSidecarMessages ?? [];
        });
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toContain('Context from `calc.ts:2`');
        expect(sentMessages[0]).toContain('const sum = a + b;');
        expect(sentMessages[0]).toContain('Explain why sum was extracted');
    });
});
