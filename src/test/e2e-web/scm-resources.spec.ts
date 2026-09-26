/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web SCM Resources', () => {
    test('should list modified and added files with correct status badges', async ({ page, server, testRepo }) => {
        // Create initial commit
        testRepo.writeFile('committed.txt', 'hello world\n');
        testRepo.describe('initial commit');
        testRepo.new();

        // Create working copy changes: 1 modified, 1 added
        testRepo.writeFile('committed.txt', 'hello world modified\n');
        testRepo.writeFile('untracked.txt', 'new untracked file\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Find working copy resource group
        const workingCopyGroup = page.locator('[data-testid="scm-group-working-copy"]');
        await expect(workingCopyGroup).toBeVisible();

        // Verify committed.txt has 'M' badge
        const modifiedItem = workingCopyGroup
            .locator('[data-testid="scm-resource-item"]')
            .filter({ hasText: 'committed.txt' });
        await expect(modifiedItem).toBeVisible();
        await expect(modifiedItem.locator('.status-badge')).toHaveText('M');

        // Verify untracked.txt has 'A' badge
        const addedItem = workingCopyGroup
            .locator('[data-testid="scm-resource-item"]')
            .filter({ hasText: 'untracked.txt' });
        await expect(addedItem).toBeVisible();
        await expect(addedItem.locator('.status-badge')).toHaveText('A');
    });

    test('should display clean working copy when there are no changes', async ({ page, server, testRepo }) => {
        testRepo.writeFile('file.txt', 'content\n');
        testRepo.describe('clean revision');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Verify working copy has no resource items
        const workingCopyItems = page.locator(
            '[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]',
        );
        await expect(workingCopyItems).toHaveCount(0);
    });

    test('should list deleted files with D status badge and strikethrough styling', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('remove-me.txt', 'to be deleted\n');
        testRepo.describe('initial commit');
        testRepo.new();

        // Delete the file from working copy
        testRepo.deleteFile('remove-me.txt');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const workingCopyGroup = page.locator('[data-testid="scm-group-working-copy"]');
        const deletedItem = workingCopyGroup
            .locator('[data-testid="scm-resource-item"]')
            .filter({ hasText: 'remove-me.txt' });

        await expect(deletedItem).toBeVisible();
        await expect(deletedItem.locator('.status-badge')).toHaveText('D');
        await expect(deletedItem.locator('.file-name')).toHaveClass(/deleted/);
    });

    test('should maintain strict 22px row height and prevent layout shift on hover with baseline alignment', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('committed.txt', 'hello\n');
        testRepo.describe('initial commit');
        testRepo.new();

        // Create multiple modified/added files including nested paths
        testRepo.writeFile('committed.txt', 'hello updated\n');
        testRepo.writeFile('src/components/button.ts', 'export const button = true;\n');
        testRepo.writeFile('docs/guide/readme.md', '# Readme\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const workingCopyGroup = page.locator('[data-testid="scm-group-working-copy"]');
        await expect(workingCopyGroup).toBeVisible();

        const groupHeader = workingCopyGroup.locator('.group-header');
        const headerBox = await groupHeader.boundingBox();
        expect(headerBox).not.toBeNull();
        expect(Math.round(headerBox?.height ?? 0)).toBe(22);

        const items = workingCopyGroup.locator('[data-testid="scm-resource-item"]');
        await expect(items).toHaveCount(3);

        // Verify typography and baseline alignment on nested item
        const nestedItem = items.filter({ hasText: 'button.ts' });
        await expect(nestedItem).toBeVisible();

        const fileName = nestedItem.locator('.file-name');
        const dirName = nestedItem.locator('.dir-name');
        await expect(fileName).toHaveText('button.ts');
        await expect(dirName).toHaveText('src/components');

        // Check font styling: normal weight (400), not bold/semi-bold
        const fileNameWeight = await fileName.evaluate((el) => window.getComputedStyle(el).fontWeight);
        expect(fileNameWeight).toBe('400');

        // Check baseline alignment container style
        const containerAlign = await nestedItem
            .locator('.resource-label-container')
            .evaluate((el) => window.getComputedStyle(el).alignItems);
        expect(containerAlign).toBe('baseline');

        // Measure all items before hover
        const initialBoxes = await Promise.all([
            items.nth(0).boundingBox(),
            items.nth(1).boundingBox(),
            items.nth(2).boundingBox(),
        ]);

        for (const box of initialBoxes) {
            expect(box).not.toBeNull();
            expect(Math.round(box?.height ?? 0)).toBe(22);
        }

        // Capture initial y coordinate of the second and third items
        const item1InitialY = initialBoxes[1]?.y ?? 0;
        const item2InitialY = initialBoxes[2]?.y ?? 0;

        // Hover over the first item
        await items.nth(0).hover();

        // Ensure hover actions are visible
        const hoverActions0 = items.nth(0).locator('.hover-actions');
        await expect(hoverActions0).toBeVisible();

        // Measure item 0 during hover - row height must remain strictly 22px
        const hoveredBox0 = await items.nth(0).boundingBox();
        expect(hoveredBox0).not.toBeNull();
        expect(Math.round(hoveredBox0?.height ?? 0)).toBe(22);

        // Subsequent items must NOT have shifted vertically at all
        const item1HoveredY = (await items.nth(1).boundingBox())?.y ?? 0;
        const item2HoveredY = (await items.nth(2).boundingBox())?.y ?? 0;
        expect(Math.round(item1HoveredY)).toBe(Math.round(item1InitialY));
        expect(Math.round(item2HoveredY)).toBe(Math.round(item2InitialY));

        // Hover over the second item
        await items.nth(1).hover();
        const hoverActions1 = items.nth(1).locator('.hover-actions');
        await expect(hoverActions1).toBeVisible();

        const hoveredBox1 = await items.nth(1).boundingBox();
        expect(hoveredBox1).not.toBeNull();
        expect(Math.round(hoveredBox1?.height ?? 0)).toBe(22);

        // Subsequent item 2 must still NOT have shifted
        const item2HoveredYSecond = (await items.nth(2).boundingBox())?.y ?? 0;
        expect(Math.round(item2HoveredYSecond)).toBe(Math.round(item2InitialY));

        // Capture screenshot of refined SCM pane
        const scmPane = page.locator('[data-testid="scm-pane"]');
        await scmPane.screenshot({
            path: path.join(ARTIFACT_DIR, 'scm-pane-layout.png'),
        });

        // Record animated GIF flow demonstrating hover stability
        await recordGifFlow(
            page,
            async (captureFrame) => {
                // Initial state
                await page.mouse.move(10, 10);
                await captureFrame();

                // Hover first item
                await items.nth(0).hover();
                await page.waitForTimeout(100);
                await captureFrame();

                // Hover second item
                await items.nth(1).hover();
                await page.waitForTimeout(100);
                await captureFrame();

                // Hover third item
                await items.nth(2).hover();
                await page.waitForTimeout(100);
                await captureFrame();

                // Move out
                await page.mouse.move(10, 10);
                await page.waitForTimeout(100);
                await captureFrame();
            },
            {
                outputPath: path.join(ARTIFACT_DIR, 'scm-hover-stability.gif'),
                framerate: 1.5,
                scale: 640,
            },
        );
    });
});
