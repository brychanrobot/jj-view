/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { buildGraph } from '../test-repo';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Quick Open (Ctrl+P / Cmd+P)', () => {
    test('should open Go to File with Ctrl+P, prioritize open and modified files, fuzzy search paths, and open selected file in File Viewer', async ({
        page,
        server,
        testRepo,
    }) => {
        await buildGraph(testRepo, [
            {
                label: 'base',
                description: 'initial repository files',
                files: {
                    'README.md': '# Project Documentation\n',
                    'src/main.ts': 'export function bootstrap() {\n  return "ready";\n}\n',
                    'src/core/jj-service.ts': 'export class JjService {}\n',
                    'chrome/browser/ui/views/frame/browser_view.cc':
                        '// Chromium BrowserView implementation\nvoid BrowserView::Init() {}\n',
                    'chrome/browser/ui/views/frame/browser_view.h':
                        '// Chromium BrowserView header\nclass BrowserView {};\n',
                    'content/browser/web_contents/web_contents_impl.cc':
                        '// WebContentsImpl implementation\nvoid WebContentsImpl::Load() {}\n',
                },
            },
            {
                label: 'wc',
                parents: ['base'],
                description: 'working copy with modified file',
                files: {
                    'src/core/jj-service.ts': 'export class JjService {\n  readonly version = 2;\n}\n',
                },
                isCurrentWorkingCopy: true,
            },
        ]);

        await recordGifFlow(
            page,
            async (captureFrame) => {
                await page.goto(server.serverUrl);
                await waitForScmReady(page);
                await expect(
                    page.locator('[data-testid="scm-resource-item"]').filter({ hasText: 'jj-service.ts' }).first(),
                ).toBeVisible({ timeout: 10000 });
                await captureFrame();

                // 1. Press Ctrl+P to open Quick Open ("Go to File")
                await page.keyboard.press('Control+p');

                const widget = page.locator('[data-testid="quick-input-widget"]');
                await expect(widget).toBeVisible({ timeout: 5000 });
                await expect(page.locator('[data-testid="quick-input-title"]')).toHaveText('Go to File');

                // Wait for workspace files to populate alongside the prioritized working-copy modified file
                const items = widget.locator('.quick-pick-item');
                await expect(items).toHaveCount(6, { timeout: 5000 });

                // Working-copy modified file (src/core/jj-service.ts) must be prioritized at #1 with "Modified" badge
                const firstItem = items.nth(0);
                await expect(firstItem.locator('.item-label')).toHaveText('jj-service.ts');
                await expect(firstItem.locator('.item-description')).toHaveText('src/core');
                await expect(firstItem.locator('.item-detail')).toHaveText('Modified');

                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'quick-open-initial.png') });
                await captureFrame();

                // 2. Type fuzzy abbreviation "bview.cc" -> should rank browser_view.cc #1
                const input = page.locator('[data-testid="quick-input-text-input"]');
                await input.fill('bview.cc');
                await expect(items).toHaveCount(1);
                await expect(items.first()).toHaveClass(/active/);
                await expect(items.first().locator('.item-label')).toHaveText('browser_view.cc');
                await expect(items.first().locator('.item-description')).toHaveText('chrome/browser/ui/views/frame');

                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'quick-open-fuzzy.png') });
                await captureFrame();

                // 3. Press Enter to open browser_view.cc in the File Viewer
                await input.press('Enter');
                await expect(widget).toHaveCount(0);

                const fileViewer = page.locator('[data-testid="pierre-file-viewer"]');
                await expect(fileViewer).toBeVisible({ timeout: 5000 });
                await expect(fileViewer).toContainText('BrowserView::Init()');
                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'quick-open-file-viewer.png') });
                await captureFrame();

                // 4. Press Ctrl+P again: browser_view.cc is now an open tab so it ranks #1 with "Open" badge
                await page.keyboard.press('Control+p');
                await expect(widget).toBeVisible({ timeout: 5000 });
                await expect(items.first().locator('.item-label')).toHaveText('browser_view.cc');
                await expect(items.first().locator('.item-detail')).toHaveText('Open');
                await captureFrame();

                // 5. Multi-token fuzzy search: "content wci.cc" -> web_contents_impl.cc
                await input.fill('content wci.cc');
                await expect(items.first().locator('.item-label')).toHaveText('web_contents_impl.cc');
                await expect(items.first().locator('.item-description')).toHaveText('content/browser/web_contents');
                await captureFrame();

                await input.press('Enter');
                await expect(widget).toHaveCount(0);
                await expect(fileViewer).toContainText('WebContentsImpl::Load()');
                await captureFrame();
            },
            { outputPath: path.join(ARTIFACT_DIR, 'quick-open-flow.gif') },
        );
    });
});
