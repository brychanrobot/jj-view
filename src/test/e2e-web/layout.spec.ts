/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForScmReady } from './standalone-fixture';

const LOG_HEADER_HEIGHT = 35;
/** Tolerance for sub-pixel rounding across header borders and flex layout. */
const PX_TOLERANCE = 3;

function verticalHandle(page: Page): Locator {
    return page.locator('[data-testid="split-pane"].vertical > [data-testid="split-handle"]');
}

function horizontalHandle(page: Page): Locator {
    return page.locator('[data-testid="split-pane"].horizontal > [data-testid="split-handle"]');
}

async function heightOf(locator: Locator): Promise<number> {
    const box = await locator.boundingBox();
    if (!box) {
        throw new Error('Element has no bounding box');
    }
    return box.height;
}

async function widthOf(locator: Locator): Promise<number> {
    const box = await locator.boundingBox();
    if (!box) {
        throw new Error('Element has no bounding box');
    }
    return box.width;
}

async function dragHandle(page: Page, handle: Locator, dx: number, dy: number): Promise<void> {
    const box = await handle.boundingBox();
    if (!box) {
        throw new Error('Handle has no bounding box');
    }
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
    await page.mouse.up();
}

/** Height the log pane would need to show every row without scrolling. */
async function naturalLogHeight(page: Page): Promise<number> {
    const graph = page.locator('[data-testid="log-content"] .scroll-container > *').first();
    await expect(graph).toBeVisible();
    return LOG_HEADER_HEIGHT + (await heightOf(graph));
}

async function expectLogShows(page: Page, text: string): Promise<void> {
    await expect(page.locator('[data-testid="log-content"]').getByText(text)).toBeVisible({ timeout: 15000 });
}

test.describe('Standalone Web Layout Persistence', () => {
    test('log pane defaults to its content height for a short log', async ({ page, server, testRepo }) => {
        testRepo.writeFile('a.txt', 'a\n');
        testRepo.describe('first commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);
        await expectLogShows(page, 'first commit');

        const logPane = page.locator('[data-testid="log-pane"]');
        const mainHeight = await heightOf(page.locator('.app-main-content'));
        const natural = await naturalLogHeight(page);
        expect(natural).toBeLessThan(mainHeight * 0.5);

        await expect
            .poll(async () => Math.abs((await heightOf(logPane)) - natural), { timeout: 5000 })
            .toBeLessThanOrEqual(PX_TOLERANCE);
    });

    test('log pane is capped at half the window for a long log', async ({ page, server, testRepo }) => {
        for (let i = 0; i < 40; i++) {
            testRepo.writeFile('a.txt', `rev ${i}\n`);
            testRepo.describe(`commit ${i}`);
            testRepo.new();
        }

        await page.goto(server.serverUrl);
        await waitForScmReady(page);
        await expectLogShows(page, 'commit 0');

        const logPane = page.locator('[data-testid="log-pane"]');
        const mainHeight = await heightOf(page.locator('.app-main-content'));
        const natural = await naturalLogHeight(page);
        expect(natural).toBeGreaterThan(mainHeight * 0.5);

        await expect
            .poll(async () => Math.abs((await heightOf(logPane)) - mainHeight * 0.5), { timeout: 5000 })
            .toBeLessThanOrEqual(PX_TOLERANCE);
    });

    test('user-resized log height and sidebar width survive a reload', async ({ page, server, testRepo }) => {
        testRepo.writeFile('a.txt', 'a\n');
        testRepo.describe('first commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);
        await expectLogShows(page, 'first commit');

        const logPane = page.locator('[data-testid="log-pane"]');
        const sidebar = page.locator('[data-testid="split-pane"].horizontal > .first-pane');

        const logBefore = await heightOf(logPane);
        const sidebarBefore = await widthOf(sidebar);

        // Dragging the horizontal divider up grows the log; dragging the
        // vertical divider right grows the sidebar.
        await dragHandle(page, verticalHandle(page), 0, -120);
        await dragHandle(page, horizontalHandle(page), 100, 0);

        const expectedLog = logBefore + 120;
        const expectedSidebar = sidebarBefore + 100;
        expect(Math.abs((await heightOf(logPane)) - expectedLog)).toBeLessThanOrEqual(PX_TOLERANCE);
        expect(Math.abs((await widthOf(sidebar)) - expectedSidebar)).toBeLessThanOrEqual(PX_TOLERANCE);

        await page.reload();
        await waitForScmReady(page);
        await expectLogShows(page, 'first commit');

        // A user-chosen height must not be overridden by content-based sizing.
        expect(Math.abs((await heightOf(logPane)) - expectedLog)).toBeLessThanOrEqual(PX_TOLERANCE);
        expect(Math.abs((await widthOf(sidebar)) - expectedSidebar)).toBeLessThanOrEqual(PX_TOLERANCE);
    });

    test('dragging the log too short collapses it to the header, and the header re-expands it', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('a.txt', 'a\n');
        testRepo.describe('first commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);
        await expectLogShows(page, 'first commit');

        const logPane = page.locator('[data-testid="log-pane"]');
        const logContent = page.locator('[data-testid="log-content"]');
        const heightBefore = await heightOf(logPane);
        await expect(logPane).toHaveAttribute('data-collapsed', 'false');

        // Drag the divider down past the bottom of the log pane.
        await dragHandle(page, verticalHandle(page), 0, heightBefore + 20);

        await expect(logPane).toHaveAttribute('data-collapsed', 'true');
        expect(Math.abs((await heightOf(logPane)) - LOG_HEADER_HEIGHT)).toBeLessThanOrEqual(PX_TOLERANCE);
        await expect(page.locator('[data-testid="log-header"]')).toBeVisible();
        expect(await heightOf(logContent)).toBeLessThanOrEqual(1);

        await page.reload();
        await waitForScmReady(page);
        await expect(logPane).toHaveAttribute('data-collapsed', 'true');
        expect(Math.abs((await heightOf(logPane)) - LOG_HEADER_HEIGHT)).toBeLessThanOrEqual(PX_TOLERANCE);

        // Clicking the header restores the height from before the collapse.
        await page.locator('[data-testid="log-header"]').click();
        await expect(logPane).toHaveAttribute('data-collapsed', 'false');
        await expectLogShows(page, 'first commit');
        await expect
            .poll(async () => Math.abs((await heightOf(logPane)) - heightBefore), { timeout: 5000 })
            .toBeLessThanOrEqual(PX_TOLERANCE);

        await page.reload();
        await waitForScmReady(page);
        await expect(logPane).toHaveAttribute('data-collapsed', 'false');
    });
});
