/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Diff Viewer', () => {
    test('should mount PierreDiffViewer and show side-by-side diff when clicking a modified resource', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('feature.txt', 'line 1\nline 2 original\nline 3\n');
        testRepo.describe('initial commit');
        testRepo.new();

        testRepo.writeFile('feature.txt', 'line 1\nline 2 updated\nline 3\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Click the modified resource item in the SCM pane
        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'feature.txt' });
        await expect(item).toBeVisible();
        await item.click();

        // Verify the Pierre diff viewer is mounted in the main editor area
        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

        // Verify tab displays the file name and toolbar header is removed
        const tab = page.locator('[data-testid="tab-bar-container"] .tab').first();
        await expect(tab).toBeVisible();
        await expect(tab.locator('.tab-label')).toContainText('feature.txt');
        await expect(diffViewer.locator('.diff-toolbar')).toHaveCount(0);

        // Verify diff content is rendered
        const diffContainer = diffViewer.locator('[data-testid="diff-content-container"]');
        await expect(diffContainer).toBeVisible();

        // Verify real diff line contents are rendered
        await expect(diffContainer.getByText('line 2 original')).toBeVisible({ timeout: 5000 });
        await expect(diffContainer.getByText('line 2 updated')).toBeVisible({ timeout: 5000 });

        // Verify diff style toggle buttons
        const splitBtn = diffViewer.locator('[data-testid="toggle-split-diff"]');
        const unifiedBtn = diffViewer.locator('[data-testid="toggle-unified-diff"]');
        await expect(splitBtn).toBeVisible();
        await expect(unifiedBtn).toBeVisible();

        // Switch to unified diff
        await unifiedBtn.click();
        await expect(unifiedBtn).toHaveClass(/active/);

        // Switch back to split diff
        await splitBtn.click();
        await expect(splitBtn).toHaveClass(/active/);
    });

    test('should display binary diff fallback card for binary files', async ({ page, server, testRepo }) => {
        testRepo.writeFile('init.txt', 'init\n');
        testRepo.describe('initial commit');
        testRepo.new();

        // Write a binary file with null bytes
        testRepo.writeFile('logo.png', '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'logo.png' });
        await expect(item).toBeVisible();
        await item.click();

        // Verify binary fallback card is displayed instead of Pierre diff editor
        const binaryCard = page.locator('[data-testid="binary-diff-card"]');
        await expect(binaryCard).toBeVisible({ timeout: 5000 });
        await expect(binaryCard).toContainText('Binary file not shown');
        await expect(binaryCard.locator('.binary-filename')).toContainText('logo.png');
    });

    test('should render syntax highlighted code tokens with Pierre theme in diff viewer', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile(
            'service.ts',
            'export function calculateSum(x: number, y: number): number {\n    return x + y;\n}\n',
        );
        testRepo.describe('feat: initial math service');
        testRepo.new();

        testRepo.writeFile(
            'service.ts',
            'export function calculateSum(x: number, y: number): number {\n    // Sum calculation\n    return x + y * 2;\n}\n',
        );

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Click the modified TypeScript file
        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'service.ts' });
        await expect(item).toBeVisible();
        await item.click();

        // Verify the Pierre diff viewer is mounted
        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

        // Verify diff content is rendered
        const diffContainer = diffViewer.locator('[data-testid="diff-content-container"]');
        await expect(diffContainer).toBeVisible();
        await expect(diffContainer.getByText('calculateSum').first()).toBeVisible({ timeout: 5000 });

        // Verify syntax highlighted tokens exist inside diff container
        const tokensWithColor = diffContainer.locator('span[style*="color"]');
        await expect(tokensWithColor.first()).toBeVisible({ timeout: 5000 });
        const tokenCount = await tokensWithColor.count();
        expect(tokenCount).toBeGreaterThan(0);
    });
});
