/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, test, waitForScmReady } from './standalone-fixture';

test.describe('Diff Visual Inspection & Diagnostics', () => {
    test('opens diff and captures screenshots and DOM diagnostics', async ({ page, server, testRepo }) => {
        // Capture console messages and errors
        page.on('console', (msg) => {
            console.log(`[Browser Console ${msg.type()}]:`, msg.text());
        });
        page.on('pageerror', (err) => {
            console.error('[Browser PageError]:', err);
        });

        // Create base commit with a realistic multi-line file
        const originalLines = [
            'import { describe, it, expect } from "vitest";',
            '',
            'export class Calculator {',
            '    add(a: number, b: number): number {',
            '        return a + b;',
            '    }',
            '',
            '    subtract(a: number, b: number): number {',
            '        return a - b;',
            '    }',
            '',
            '    multiply(a: number, b: number): number {',
            '        return a * b;',
            '    }',
            '}',
        ].join('\n');

        testRepo.writeFile('calculator.ts', originalLines);
        testRepo.describe('feat: initial calculator implementation');
        testRepo.new();

        // Update calculator.ts and add a new file
        const modifiedLines = [
            'import { describe, it, expect } from "vitest";',
            'import { Logger } from "./logger";',
            '',
            'export class Calculator {',
            '    private logger = new Logger();',
            '',
            '    add(a: number, b: number): number {',
            '        this.logger.log("adding");',
            '        return a + b;',
            '    }',
            '',
            '    subtract(a: number, b: number): number {',
            '        return a - b;',
            '    }',
            '',
            '    divide(a: number, b: number): number {',
            '        if (b === 0) throw new Error("Divide by zero");',
            '        return a / b;',
            '    }',
            '}',
        ].join('\n');

        testRepo.writeFile('calculator.ts', modifiedLines);

        const newFileLines = [
            '// Copyright 2026',
            'export class Logger {',
            '    log(msg: string): void {',
            '        console.log("[LOG]: " + msg);',
            '    }',
            '}',
        ].join('\n');
        testRepo.writeFile('logger.ts', newFileLines);

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // 1. Inspect modified file diff (calculator.ts)
        const calcItem = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'calculator.ts' });
        await expect(calcItem).toBeVisible();
        await calcItem.click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

        const diffContainer = diffViewer.locator('[data-testid="diff-content-container"]');
        await expect(diffContainer).toBeVisible();

        // Wait for rendering to settle
        await page.waitForTimeout(1000);

        // Take screenshots of modified file diff
        await page.screenshot({
            path: path.join(ARTIFACT_DIR, 'diff-modified-fullpage.png'),
            fullPage: true,
        });
        await diffContainer.screenshot({
            path: path.join(ARTIFACT_DIR, 'diff-modified-container.png'),
        });

        // Save DOM structure of the diff container and shadow root for deep inspection
        const shadowDom = await diffContainer.evaluate((el) => {
            const host = el.querySelector('diffs-container') || el.querySelector('.pierre-diff-host');
            return {
                hostHtml: host?.innerHTML || '',
                shadowHtml: host?.shadowRoot?.innerHTML || 'NO_SHADOW_ROOT',
                hasAdoptedStyleSheets: Boolean(host?.shadowRoot?.adoptedStyleSheets?.length),
                adoptedStyleSheetCount: host?.shadowRoot?.adoptedStyleSheets?.length ?? 0,
            };
        });
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'diff-shadow-dom.html'), JSON.stringify(shadowDom, null, 2));

        // 2. Toggle to unified diff
        const unifiedBtn = diffViewer.locator('[data-testid="toggle-unified-diff"]');
        await unifiedBtn.click();
        await page.waitForTimeout(500);

        await page.screenshot({
            path: path.join(ARTIFACT_DIR, 'diff-unified-fullpage.png'),
            fullPage: true,
        });

        // 3. Inspect added file diff (logger.ts)
        const loggerItem = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'logger.ts' });
        await expect(loggerItem).toBeVisible();
        await loggerItem.click();

        await page.waitForTimeout(1000);

        await page.screenshot({
            path: path.join(ARTIFACT_DIR, 'diff-added-fullpage.png'),
            fullPage: true,
        });
        await diffContainer.screenshot({
            path: path.join(ARTIFACT_DIR, 'diff-added-container.png'),
        });

        const addedDom = await diffContainer.evaluate((el) => el.innerHTML);
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'diff-added-dom.html'), addedDom);

        // 4. Inspect commit details view
        const logContent = page.locator('[data-testid="log-content"]');
        const targetCommit = logContent
            .locator('.commit-row')
            .filter({ hasText: 'feat: initial calculator implementation' });
        await targetCommit.locator('.commit-desc').click();
        const detailsView = page.locator('[data-testid="commit-details-view"]');
        await expect(detailsView).toBeVisible({ timeout: 5000 });
        await page.waitForTimeout(500);

        await page.screenshot({
            path: path.join(ARTIFACT_DIR, 'commit-details-fullpage.png'),
            fullPage: true,
        });

        console.log('Screenshots and DOM diagnostics saved successfully to', ARTIFACT_DIR);
    });
});
