/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createTestPng(
    width: number,
    height: number,
    pixelFn: (x: number, y: number) => [number, number, number, number],
): Buffer {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const rowStart = y * stride;
        raw[rowStart] = 0; // filter type 0
        for (let x = 0; x < width; x++) {
            const [r, g, b, a] = pixelFn(x, y);
            const idx = rowStart + 1 + x * 4;
            raw[idx] = r;
            raw[idx + 1] = g;
            raw[idx + 2] = b;
            raw[idx + 3] = a;
        }
    }

    const idat = zlib.deflateSync(raw);
    return Buffer.concat([
        signature,
        makePngChunk('IHDR', ihdr),
        makePngChunk('IDAT', idat),
        makePngChunk('IEND', Buffer.alloc(0)),
    ]);
}

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

    test('should display binary diff fallback card for non-image binary files', async ({ page, server, testRepo }) => {
        testRepo.writeFile('init.txt', 'init\n');
        testRepo.describe('initial commit');
        testRepo.new();

        // Write a non-image binary file with null bytes
        testRepo.writeFile('module.wasm', '\x00asm\x01\x00\x00\x00');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'module.wasm' });
        await expect(item).toBeVisible();
        await item.click();

        // Verify binary fallback card is displayed instead of Pierre diff editor
        const binaryCard = page.locator('[data-testid="binary-diff-card"]');
        await expect(binaryCard).toBeVisible({ timeout: 5000 });
        await expect(binaryCard).toContainText('Binary file not shown');
        await expect(binaryCard.locator('.binary-filename')).toContainText('module.wasm');
    });

    test('should render interactive image diff viewer with 2-Up, Swipe, Onion Skin, and Difference modes', async ({
        page,
        server,
        testRepo,
    }) => {
        const beforePng = createTestPng(200, 140, (x, y) => {
            const dx = x - 75;
            const dy = y - 70;
            if (dx * dx + dy * dy <= 38 * 38) {
                return [56, 189, 248, 255]; // cyan circle on left
            }
            if (x > 16 && x < 184 && y > 16 && y < 124) {
                return [30, 58, 138, 230]; // deep blue card
            }
            return [0, 0, 0, 0]; // transparent border
        });

        const afterPng = createTestPng(200, 140, (x, y) => {
            const dx = x - 125;
            const dy = y - 70;
            if (dx * dx + dy * dy <= 42 * 42) {
                return [251, 146, 60, 255]; // vibrant orange circle shifted right
            }
            if (x > 16 && x < 184 && y > 16 && y < 124) {
                return [20, 83, 45, 240]; // emerald green card
            }
            return [0, 0, 0, 0];
        });

        testRepo.writeBinaryFile('banner.png', beforePng);
        testRepo.describe('feat: add initial banner image');
        testRepo.new();
        testRepo.writeBinaryFile('banner.png', afterPng);

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'banner.png' });
        await expect(item).toBeVisible();
        await item.click();

        const imageDiff = page.locator('[data-testid="image-diff-viewer"]');
        await expect(imageDiff).toBeVisible({ timeout: 5000 });
        await expect(imageDiff.locator('[data-testid="image-pane-before"]')).toBeVisible();
        await expect(imageDiff.locator('[data-testid="image-pane-after"]')).toBeVisible();

        // Wait for both images to decode and populate natural dimensions
        await expect(imageDiff.locator('[data-testid="image-meta-before"]')).toContainText('200 × 140 px');
        await expect(imageDiff.locator('[data-testid="image-meta-after"]')).toContainText('200 × 140 px');
        await expect(imageDiff.locator('[data-testid="image-diff-dimension-summary"]')).toContainText('200 × 140 px');
        await expect(imageDiff.locator('[data-testid="image-diff-byte-delta"]')).toBeVisible();

        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'image-diff-2up.png') });

        await recordGifFlow(
            page,
            async (capture) => {
                await capture(); // 2-Up view

                // Switch to Swipe mode
                await imageDiff.locator('[data-testid="image-diff-mode-swipe"]').click();
                await expect(imageDiff.locator('[data-testid="image-diff-swipe-view"]')).toBeVisible();
                await capture();

                // Adjust swipe slider to 30%
                const swipeSlider = imageDiff.locator('[data-testid="image-diff-swipe-slider"]');
                await swipeSlider.fill('30');
                await swipeSlider.dispatchEvent('input');
                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'image-diff-swipe.png') });
                await capture();

                // Switch to Onion Skin mode
                await imageDiff.locator('[data-testid="image-diff-mode-onion"]').click();
                await expect(imageDiff.locator('[data-testid="image-diff-onion-view"]')).toBeVisible();
                await capture();

                // Switch to Difference mode
                await imageDiff.locator('[data-testid="image-diff-mode-difference"]').click();
                await expect(imageDiff.locator('[data-testid="image-diff-difference-view"]')).toBeVisible();
                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'image-diff-difference.png') });
                await capture();
            },
            { outputPath: path.join(ARTIFACT_DIR, 'image-diff-flow.gif') },
        );
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

    test('should highlight embedded JavaScript inside C++ R"js(...)js" raw string literals', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('bootstrap.cc', '// Bootstrap file\n');
        testRepo.describe('initial commit');
        testRepo.new();

        testRepo.writeFile(
            'bootstrap.cc',
            `static constexpr char kBootstrapScriptTemplate[] = R"js(
(function() {
  window.__webui_bootstrap_active = true;
  const source = $1;
  const ping = () => {
    if (!window.__webui_bootstrap_active) return;
    setTimeout(ping, 50);
  };
  ping();
})();
)js";
`,
        );

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const item = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'bootstrap.cc' });
        await expect(item).toBeVisible();
        await item.click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

        const diffContainer = diffViewer.locator('[data-testid="diff-content-container"]');
        await expect(diffContainer).toBeVisible();
        await expect(diffContainer.getByText('__webui_bootstrap_active').first()).toBeVisible({ timeout: 5000 });

        // Wait for syntax highlighting inside the raw string to produce multiple distinct token styles/colors
        await expect
            .poll(
                async () => {
                    return await diffContainer.evaluate((container) => {
                        const root = container.querySelector('diffs-container')?.shadowRoot ?? container;
                        const spans = Array.from(root.querySelectorAll('span'));
                        const jsTokens = new Set(['function', 'const', 'true', 'return', '50', 'setTimeout']);
                        const styles = new Set<string>();
                        for (const span of spans) {
                            const text = (span.textContent ?? '').trim();
                            if (jsTokens.has(text)) {
                                styles.add(span.getAttribute('style') ?? window.getComputedStyle(span).color);
                            }
                        }
                        return styles.size;
                    });
                },
                { timeout: 10000 },
            )
            .toBeGreaterThan(2);
    });
});
