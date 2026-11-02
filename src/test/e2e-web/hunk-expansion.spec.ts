/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordInteractionFlow, test, waitForScmReady } from './standalone-fixture';

const OUT_DIR = process.env.SCREENSHOT_OUT_DIR || process.env.ARTIFACTS_DIR || ARTIFACT_DIR;

const originalCode = [
    'namespace demo {',
    '',
    'class Controller {',
    'public:',
    '    void Execute(int mode) {',
    '        int initialStatus = 1;',
    '        if (mode > 0) {',
    '            DoWork();',
    '        }',
    '        for (int iter = 0; iter < 5; ++iter) {',
    '            if (mode == 2) {',
    '                StepA();',
    '                StepB();',
    '                StepC();',
    '                StepD();',
    '                StepE();',
    '            }',
    '            int checkpoint = 42;',
    '            ProcessScope();',
    '        }',
    '        // Context line 21',
    '        // Context line 22',
    '        // Context line 23',
    '        // Context line 24',
    '        // Context line 25',
    '        // Context line 26',
    '        // Context line 27',
    '        // Context line 28',
    '        // Context line 29',
    '        // Context line 30',
    '        // Context line 31',
    '        // Context line 32',
    '        // Context line 33',
    '        // Context line 34',
    '        // Context line 35',
    '        // Context line 36',
    '        // Context line 37',
    '        // Context line 38',
    '        // Context line 39',
    '        // Context line 40',
    '        // Context line 41',
    '        // Context line 42',
    '        // Context line 43',
    '        // Context line 44',
    '        // Context line 45',
    '        // Context line 46',
    '        // Context line 47',
    '        // Context line 48',
    '        // Context line 49',
    '        // Context line 50',
    '        if (mode < 0) {',
    '            CleanUp();',
    '        }',
    '    }',
    '};',
    '',
    '}',
].join('\n');

const modifiedCode = [
    'namespace demo {',
    '',
    'class Controller {',
    'public:',
    '    void Execute(int mode) {',
    '        int initialStatus = 1;',
    '        if (mode > 0) {',
    '            DoWorkUpdated();',
    '        }',
    '        for (int iter = 0; iter < 5; ++iter) {',
    '            if (mode == 2) {',
    '                StepA();',
    '                StepB();',
    '                StepC();',
    '                StepD();',
    '                StepE();',
    '            }',
    '            int checkpoint = 42;',
    '            ProcessScope();',
    '        }',
    '        // Context line 21',
    '        // Context line 22',
    '        // Context line 23',
    '        // Context line 24',
    '        // Context line 25',
    '        // Context line 26',
    '        // Context line 27',
    '        // Context line 28',
    '        // Context line 29',
    '        // Context line 30',
    '        // Context line 31',
    '        // Context line 32',
    '        // Context line 33',
    '        // Context line 34',
    '        // Context line 35',
    '        // Context line 36',
    '        // Context line 37',
    '        // Context line 38',
    '        // Context line 39',
    '        // Context line 40',
    '        // Context line 41',
    '        // Context line 42',
    '        // Context line 43',
    '        // Context line 44',
    '        // Context line 45',
    '        // Context line 46',
    '        // Context line 47',
    '        // Context line 48',
    '        // Context line 49',
    '        // Context line 50',
    '        if (mode < 0) {',
    '            CleanUpUpdated();',
    '        }',
    '    }',
    '};',
    '',
    '}',
].join('\n');

test.describe('Hidden Line (Unchanged Context) Expansion', () => {
    test('renders 32px recessed seam, ast tooltip, progressive step-out, drag peeling, and unified/narrow views', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('controller.cc', originalCode);
        testRepo.describe('feat: initial controller');
        testRepo.new();
        testRepo.writeFile('controller.cc', modifiedCode);

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Open controller.cc in the diff viewer
        const resourceItem = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'controller.cc' });
        await expect(resourceItem).toBeVisible();
        await resourceItem.click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

        // Wait for diff rendering and seam enhancement
        const additionsSeam = page.locator('.jj-hunk-seam.additions-half').first();
        const deletionsSeam = page.locator('.jj-hunk-seam.deletions-half').first();
        await expect(additionsSeam).toBeVisible({ timeout: 5000 });
        await expect(deletionsSeam).toBeVisible({ timeout: 5000 });

        // Verify visible text selection highlights (::selection non-transparent in Shadow DOM & outer document)
        const selectionCheck = await additionsSeam.evaluate((seam) => {
            const root = seam.getRootNode() as ShadowRoot;
            const line = root.querySelector('[data-line]') as HTMLElement | null;
            const lineCs = line ? window.getComputedStyle(line, '::selection') : null;
            const bodyCs = window.getComputedStyle(document.body, '::selection');
            const diffsContainer = (root.host || seam.closest('[data-diffs]')) as HTMLElement | null;
            const hostCs = diffsContainer ? window.getComputedStyle(diffsContainer) : null;

            // Select text in the diff line using DOM Selection API
            let selectedText = '';
            if (line) {
                const range = document.createRange();
                range.selectNodeContents(line);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
                selectedText = sel?.toString() || '';
            }

            return {
                lineFound: Boolean(line),
                selectedTextLength: selectedText.length,
                lineSelectionBg: lineCs?.backgroundColor,
                bodySelectionBg: bodyCs?.backgroundColor,
                editorSelectionBg: hostCs?.getPropertyValue('--diffs-editor-selection-bg')?.trim(),
                diffsSelectionColor: hostCs?.getPropertyValue('--diffs-selection-color')?.trim(),
            };
        });

        expect(selectionCheck.lineFound).toBe(true);
        expect(selectionCheck.selectedTextLength).toBeGreaterThan(0);
        expect(selectionCheck.lineSelectionBg).toBeDefined();
        expect(selectionCheck.lineSelectionBg).not.toBe('rgba(0, 0, 0, 0)');
        expect(selectionCheck.lineSelectionBg).not.toBe('transparent');
        expect(selectionCheck.bodySelectionBg).toBeDefined();
        expect(selectionCheck.bodySelectionBg).not.toBe('rgba(0, 0, 0, 0)');
        expect(selectionCheck.bodySelectionBg).not.toBe('transparent');
        expect(selectionCheck.editorSelectionBg || selectionCheck.diffsSelectionColor).toBeTruthy();
        expect(selectionCheck.editorSelectionBg).not.toBe('var(--diffs-line-bg)');

        const selectionScreenshotPath = path.join(OUT_DIR, 'selection_highlight_diff.png');
        await page.screenshot({ path: selectionScreenshotPath });
        await page.evaluate(() => window.getSelection()?.removeAllRanges());

        // 1. Verify Single-Row Recessed Center Seam (32px height)
        const seamBox = await additionsSeam.boundingBox();
        expect(seamBox).not.toBeNull();
        if (seamBox) {
            expect(Math.abs(seamBox.height - 32)).toBeLessThanOrEqual(2);
        }

        // Verify zero Unicode emoji/dingbats in seam text content
        const seamText = (await additionsSeam.textContent()) || '';
        expect(seamText).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u);

        // Verify outer range badges (Old and New)
        const oldTag = deletionsSeam.locator('.seam-gutter-tag').filter({ hasText: 'Old' }).first();
        const newTag = additionsSeam.locator('.seam-gutter-tag').filter({ hasText: 'New' }).first();
        await expect(oldTag).toBeVisible();
        await expect(newTag).toBeVisible();

        // In Split Mode, verify .seam-center-cluster.seam-straddle straddles the 50% split boundary
        const cluster = additionsSeam.locator('.seam-center-cluster.seam-straddle');
        await expect(cluster).toBeVisible();
        const clusterBox = await cluster.boundingBox();
        expect(clusterBox).not.toBeNull();

        const additionsSide = page.locator('[data-additions]').first();
        const additionsBox = await additionsSide.boundingBox();
        if (clusterBox && additionsBox) {
            const clusterCenterX = clusterBox.x + clusterBox.width / 2;
            expect(Math.abs(clusterCenterX - additionsBox.x)).toBeLessThan(40);
        }

        // 2. AST +Block Hover Tooltip & Progressive Step-Out
        const astDownBtn = additionsSeam.locator('[data-role="ast-down"]');
        await expect(astDownBtn).toBeVisible();

        // Hover over the +Block button to reveal the tooltip
        await astDownBtn.hover();
        const tooltip = additionsSeam.locator('.ast-tooltip.tooltip-below');
        await expect(tooltip).toBeVisible();

        const tooltipBox = await tooltip.boundingBox();
        expect(tooltipBox).not.toBeNull();
        if (tooltipBox) {
            expect(tooltipBox.width).toBeGreaterThanOrEqual(300);
            expect(tooltipBox.height).toBeGreaterThanOrEqual(50);
        }

        await page.screenshot({
            path: path.join(OUT_DIR, 'hunk_seam_split_dark.png'),
        });

        await expect(tooltip).toContainText('BLOCK_BELOW');
        await expect(tooltip.locator('.ast-tooltip-path')).toBeVisible();
        await expect(tooltip.locator('.ast-tooltip-code')).toBeVisible();

        // Verify click once expands to the end of the inner if block
        const countBeforeClick = await page.locator('[data-line-type="context-expanded"]').count();
        await astDownBtn.click();

        // StepE is the last statement inside if (mode == 2)
        await expect(page.getByText('StepE();').first()).toBeVisible({
            timeout: 5000,
        });
        const countAfterFirst = await page.locator('[data-line-type="context-expanded"]').count();
        expect(countAfterFirst).toBeGreaterThan(countBeforeClick);

        // Verify line highlighting has context-expanded
        const expandedLine = page.locator('[data-line-type="context-expanded"]').first();
        await expect(expandedLine).toBeVisible();

        // Verify context-expanded line sets --diffs-line-bg and uses translucent background
        // so Editor's [data-selection-range] overlay (z-index: -10) is not occluded
        const expandedLineStyle = await expandedLine.evaluate((el) => {
            const cs = window.getComputedStyle(el);
            return {
                lineBgVar: cs.getPropertyValue('--diffs-line-bg').trim(),
                bgColor: cs.backgroundColor,
            };
        });
        expect(expandedLineStyle.lineBgVar).toBeTruthy();
        expect(expandedLineStyle.bgColor).toBeDefined();
        expect(expandedLineStyle.bgColor).not.toBe('');

        // Verify clicking [data-role="ast-down"] a second time automatically steps out to parent block
        const secondAstDownBtn = page.locator('.jj-hunk-seam.additions-half [data-role="ast-down"]').first();
        await expect(secondAstDownBtn).toBeVisible();
        await secondAstDownBtn.click();

        // ProcessScope() is after the if block inside the enclosing for-loop
        await expect(page.getByText('ProcessScope();').first()).toBeVisible({
            timeout: 5000,
        });
        const countAfterSecond = await page.locator('[data-line-type="context-expanded"]').count();
        expect(countAfterSecond).toBeGreaterThan(countAfterFirst);

        // 3. Middle Handle Drag-to-Peel ([data-role="expand-all"])
        const expandAllHandle = page.locator('.jj-hunk-seam.additions-half [data-role="expand-all"]').first();
        await expect(expandAllHandle).toBeVisible();
        await expect(expandAllHandle.locator('.grip-dots')).toBeVisible();

        // Ensure dock-pair buttons do NOT contain .grip-dots
        const dockPairs = page.locator('.jj-hunk-seam.additions-half .dock-pair');
        await expect(dockPairs.locator('.grip-dots')).toHaveCount(0);

        // Drag handle downward by +80px then upward by -60px
        const handleBox = await expandAllHandle.boundingBox();
        expect(handleBox).not.toBeNull();
        if (handleBox) {
            const startX = handleBox.x + handleBox.width / 2;
            const startY = handleBox.y + handleBox.height / 2;
            const linesBeforeDrag = await page.locator('[data-line-type="context-expanded"]').count();

            await page.mouse.move(startX, startY);
            await page.mouse.down();
            await page.mouse.move(startX, startY + 80, { steps: 5 });
            await page.mouse.move(startX, startY - 60, { steps: 5 });
            await page.mouse.up();

            const linesAfterDrag = await page.locator('[data-line-type="context-expanded"]').count();
            expect(linesAfterDrag).toBeGreaterThan(linesBeforeDrag);
        }

        // 4. Unified Mode, Light Theme, and Narrow Viewport (920px)
        const unifiedBtn = diffViewer.locator('[data-testid="toggle-unified-diff"]');
        await unifiedBtn.click();
        await expect(unifiedBtn).toHaveClass(/active/);

        // Verify combo-seam is rendered in unified mode if context lines remain
        const comboSeam = page.locator('.combo-seam.jj-hunk-seam').first();
        await expect(comboSeam).toBeVisible({ timeout: 5000 });
        await expect(comboSeam.locator('.seam-center-cluster')).toBeVisible();

        await page.screenshot({
            path: path.join(OUT_DIR, 'hunk_seam_unified_dark.png'),
        });

        // Narrow viewport test (<= 900px hides .seam-gutter-tag)
        await page.setViewportSize({ width: 880, height: 800 });

        const gutterTag = comboSeam.locator('.seam-gutter-tag').first();
        await expect(gutterTag).not.toBeVisible();

        // Restore viewport
        await page.setViewportSize({ width: 1280, height: 800 });
    });

    test('supports Python indentation blocks, multi-line def signatures, dict literals, and AST step-out', async ({
        page,
        server,
        testRepo,
    }) => {
        const pyOriginal = [
            'class Calculator:',
            '    """Mathematical computation engine."""',
            '',
            '    def evaluate(',
            '        self,',
            '        expression: str,',
            '    ) -> int:',
            '        config = {"strict": True, "precision": 4}',
            '        initial_val = 1',
            '        if expression.startswith("calc:"):',
            '            step_a = 10',
            '            step_b = 20',
            '            step_c = 30',
            '            step_d = 40',
            '        checkpoint = 42',
            '        # Context line 1',
            '        # Context line 2',
            '        # Context line 3',
            '        # Context line 4',
            '        # Context line 5',
            '        # Context line 6',
            '        # Context line 7',
            '        # Context line 8',
            '        # Context line 9',
            '        # Context line 10',
            '        # Context line 11',
            '        # Context line 12',
            '        # Context line 13',
            '        # Context line 14',
            '        # Context line 15',
            '        # Context line 16',
            '        # Context line 17',
            '        # Context line 18',
            '        # Context line 19',
            '        # Context line 20',
            '        final_result = 0',
            '        return final_result',
        ].join('\n');

        const pyModified = [
            'class Calculator:',
            '    """Mathematical computation engine."""',
            '',
            '    def evaluate(',
            '        self,',
            '        expression: str,',
            '    ) -> int:',
            '        config = {"strict": True, "precision": 4}',
            '        initial_val = 99',
            '        if expression.startswith("calc:"):',
            '            step_a = 10',
            '            step_b = 20',
            '            step_c = 30',
            '            step_d = 40',
            '        checkpoint = 42',
            '        # Context line 1',
            '        # Context line 2',
            '        # Context line 3',
            '        # Context line 4',
            '        # Context line 5',
            '        # Context line 6',
            '        # Context line 7',
            '        # Context line 8',
            '        # Context line 9',
            '        # Context line 10',
            '        # Context line 11',
            '        # Context line 12',
            '        # Context line 13',
            '        # Context line 14',
            '        # Context line 15',
            '        # Context line 16',
            '        # Context line 17',
            '        # Context line 18',
            '        # Context line 19',
            '        # Context line 20',
            '        final_result = 999',
            '        return final_result',
        ].join('\n');

        testRepo.writeFile('calculator.py', pyOriginal);
        testRepo.describe('feat: initial calculator');
        testRepo.new();
        testRepo.writeFile('calculator.py', pyModified);

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const resourceItem = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'calculator.py' });
        await expect(resourceItem).toBeVisible();
        await resourceItem.click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

        const additionsSeam = page.locator('.jj-hunk-seam.additions-half').first();
        await expect(additionsSeam).toBeVisible({ timeout: 5000 });

        const astDownBtn = additionsSeam.locator('[data-role="ast-down"]');
        await expect(astDownBtn).toBeVisible();

        // Hover over +Block to inspect the Python AST tooltip
        await astDownBtn.hover();
        const tooltip = additionsSeam.locator('.ast-tooltip.tooltip-below');
        await expect(tooltip).toBeVisible();
        await expect(tooltip).toContainText('BLOCK_BELOW');

        // Path should include Calculator, evaluate(), and if (...)
        const pathEl = tooltip.locator('.ast-tooltip-path');
        await expect(pathEl).toContainText('Calculator');
        await expect(pathEl).toContainText('evaluate()');
        await expect(pathEl).toContainText('if (expression.startswith(');

        // Click +Block to expand down to the end of the inner if block
        await astDownBtn.click();
        await expect(page.getByText('step_d = 40').first()).toBeVisible({
            timeout: 5000,
        });

        // Second click steps out to evaluate() function
        const secondAstDownBtn = page.locator('.jj-hunk-seam.additions-half [data-role="ast-down"]').first();
        await expect(secondAstDownBtn).toBeVisible();
        await secondAstDownBtn.click();
        await expect(page.getByText('checkpoint = 42').first()).toBeVisible({
            timeout: 5000,
        });
    });

    test('supports dynamic theme switching to light theme and renders light color-scheme seam', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('controller.cc', originalCode);
        testRepo.describe('feat: initial controller');
        testRepo.new();
        testRepo.writeFile('controller.cc', modifiedCode);

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Open controller.cc in diff viewer in default theme
        const resourceItem = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'controller.cc' });
        await expect(resourceItem).toBeVisible();
        await resourceItem.click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

        const additionsSeam = page.locator('.jj-hunk-seam.additions-half').first();
        await expect(additionsSeam).toBeVisible({ timeout: 5000 });

        // Switch to Light Theme via Command Palette
        await page.keyboard.press('Control+Shift+P');
        const quickInput = page.locator('[data-testid="quick-input-widget"]');
        await expect(quickInput).toBeVisible();
        const paletteInput = page.locator('[data-testid="quick-input-text-input"]');
        await paletteInput.fill('Color Theme');
        await page.locator('[data-testid="quick-pick-item-workbench.action.selectTheme"]').click();

        await expect(page.locator('[data-testid="quick-input-title"]')).toHaveText('Select Color Theme');
        await paletteInput.fill('github-light');
        await page.locator('[data-testid="quick-pick-item-github-light"]').click();

        await expect
            .poll(async () => {
                return await page.evaluate(() => ({
                    bodyClass: document.body.className,
                    theme: document.documentElement.getAttribute('data-theme'),
                }));
            })
            .toEqual({
                bodyClass: expect.stringContaining('vscode-light'),
                theme: 'github-light',
            });

        // Verify seam re-renders in light theme
        const lightSeam = page.locator('.jj-hunk-seam.additions-half').first();
        await expect(lightSeam).toBeVisible({ timeout: 5000 });

        // Verify visible text selection highlights in light theme
        const lightSelectionCheck = await lightSeam.evaluate((seam) => {
            const root = seam.getRootNode() as ShadowRoot;
            const line = root.querySelector('[data-line]') as HTMLElement | null;
            const lineCs = line ? window.getComputedStyle(line, '::selection') : null;
            const bodyCs = window.getComputedStyle(document.body, '::selection');
            const diffsContainer = (root.host || seam.closest('[data-diffs]')) as HTMLElement | null;
            const hostCs = diffsContainer ? window.getComputedStyle(diffsContainer) : null;
            return {
                lineFound: Boolean(line),
                lineSelectionBg: lineCs?.backgroundColor,
                bodySelectionBg: bodyCs?.backgroundColor,
                editorSelectionBg: hostCs?.getPropertyValue('--diffs-editor-selection-bg')?.trim(),
                diffsSelectionColor: hostCs?.getPropertyValue('--diffs-selection-color')?.trim(),
            };
        });
        expect(lightSelectionCheck.lineFound).toBe(true);
        expect(lightSelectionCheck.lineSelectionBg).toBeDefined();
        expect(lightSelectionCheck.lineSelectionBg).not.toBe('rgba(0, 0, 0, 0)');
        expect(lightSelectionCheck.lineSelectionBg).not.toBe('transparent');
        expect(lightSelectionCheck.bodySelectionBg).toBeDefined();
        expect(lightSelectionCheck.bodySelectionBg).not.toBe('rgba(0, 0, 0, 0)');
        expect(lightSelectionCheck.bodySelectionBg).not.toBe('transparent');
        expect(lightSelectionCheck.editorSelectionBg || lightSelectionCheck.diffsSelectionColor).toBeTruthy();
        expect(lightSelectionCheck.editorSelectionBg).not.toBe('var(--diffs-line-bg)');

        // Hover over +Block to inspect the light-themed tooltip
        const astDownBtn = lightSeam.locator('[data-role="ast-down"]');
        await expect(astDownBtn).toBeVisible();
        await astDownBtn.hover();
        const tooltip = lightSeam.locator('.ast-tooltip.tooltip-below');
        await expect(tooltip).toBeVisible();

        const lightScreenshotPath =
            process.env.LIGHT_SCREENSHOT_PATH || path.join(OUT_DIR, 'hunk_seam_split_light.png');
        await page.screenshot({ path: lightScreenshotPath });
    });

    test('renders .jj-hunk-seam in PierreMultiDiffViewer when opening multi-file diff from commit graph', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('controller.cc', originalCode);
        testRepo.describe('feat: initial controller');
        testRepo.new();
        testRepo.writeFile('controller.cc', modifiedCode);
        testRepo.describe('feat: update controller');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // 1. In Log Graph, click the commit row for 'feat: update controller'
        const logContent = page.locator('[data-testid="log-content"]');
        await expect(logContent).toBeVisible();
        const targetRow = logContent.locator('.commit-row').filter({ hasText: 'feat: update controller' });
        await targetRow.locator('.commit-desc').click();

        // 2. In Commit Details view, click "Multi-file Diff" button
        const detailsView = page.locator('[data-testid="commit-details-view"]');
        await expect(detailsView).toBeVisible({ timeout: 5000 });
        const multiDiffBtn = detailsView.getByRole('button', {
            name: /Multi-file Diff/i,
        });
        await expect(multiDiffBtn).toBeVisible();
        await multiDiffBtn.click();

        // 3. Verify PierreMultiDiffViewer mounts
        const multiDiffViewer = page.locator('[data-testid="pierre-multi-diff-viewer"]');
        await expect(multiDiffViewer).toBeVisible({ timeout: 5000 });

        // 4. Verify .jj-hunk-seam renders inside PierreMultiDiffViewer (CodeView)
        const seam = multiDiffViewer.locator('.jj-hunk-seam.additions-half').first();
        await expect(seam).toBeVisible({ timeout: 5000 });
        await expect(seam.locator('.seam-center-cluster')).toBeVisible();

        // Verify visible text selection highlights in PierreMultiDiffViewer (CodeView)
        const multiDiffSelectionCheck = await seam.evaluate((seamEl) => {
            const root = seamEl.getRootNode() as ShadowRoot | Document;
            const diffsContainer =
                seamEl.closest('diffs-container') ??
                ('querySelector' in root ? root.querySelector('diffs-container') : null) ??
                document.querySelector('diffs-container');
            const targetRoot = diffsContainer?.shadowRoot ?? ('querySelector' in root ? (root as ShadowRoot) : null);
            const line = targetRoot?.querySelector('[data-line]') as HTMLElement | null;
            const lineCs = line ? window.getComputedStyle(line, '::selection') : null;
            return {
                lineFound: Boolean(line),
                lineSelectionBg: lineCs?.backgroundColor,
            };
        });
        expect(multiDiffSelectionCheck.lineFound).toBe(true);
        expect(multiDiffSelectionCheck.lineSelectionBg).toBeDefined();
        expect(multiDiffSelectionCheck.lineSelectionBg).not.toBe('rgba(0, 0, 0, 0)');
        expect(multiDiffSelectionCheck.lineSelectionBg).not.toBe('transparent');

        // 5. Expand hunk context via [data-role="expand-all"]
        const expandAllBtn = seam.locator('[data-role="expand-all"]');
        await expect(expandAllBtn).toBeVisible();
        await expandAllBtn.click();

        // Verify context lines expand inside PierreMultiDiffViewer
        await expect(multiDiffViewer.locator('[data-line-type="context-expanded"]').first()).toBeVisible({
            timeout: 5000,
        });
    });

    test('records 24fps interaction walkthrough of AST +Block expansion and drag peeling', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('controller.cc', originalCode);
        testRepo.describe('feat: initial controller');
        testRepo.new();
        testRepo.writeFile('controller.cc', modifiedCode);

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const resourceItem = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'controller.cc' });
        await expect(resourceItem).toBeVisible();
        await resourceItem.click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

        const additionsSeam = page.locator('.jj-hunk-seam.additions-half').first();
        await expect(additionsSeam).toBeVisible({ timeout: 5000 });

        const astDownBtn = additionsSeam.locator('[data-role="ast-down"]');
        const expandAllHandle = additionsSeam.locator('[data-role="expand-all"]');

        const gifPath = path.join(OUT_DIR, 'hunk_expansion_walkthrough.gif');
        const mp4Path = path.join(OUT_DIR, 'hunk_expansion_walkthrough.mp4');

        await recordInteractionFlow(
            page,
            {
                gifPath,
                mp4Path,
                fps: 24,
                scale: 1280,
            },
            async (rec) => {
                rec.setHud('Inspect Recessed Hunk Seam');
                await rec.moveTo(expandAllHandle, 12);
                await rec.hover(8);

                rec.setHud('Hover AST +Block Tooltip');
                await rec.moveTo(astDownBtn, 12);
                await rec.hover(14);

                rec.setHud('Click +Block (Expand Inner AST Block)');
                await rec.click(astDownBtn, 8);
                await rec.hover(12);

                rec.setHud('Step Out to Enclosing AST Block');
                const secondAstBtn = page.locator('.jj-hunk-seam.additions-half [data-role="ast-down"]').first();
                await expect(secondAstBtn).toBeVisible({ timeout: 5000 });
                await rec.click(secondAstBtn, 8);
                await rec.hover(12);

                rec.setHud('1:1 Monotonic Drag Peeling');
                const currentHandle = page.locator('.jj-hunk-seam.additions-half [data-role="expand-all"]').first();
                await rec.dragBy(currentHandle, 80, 16);
                await rec.hover(10);
            },
        );

        expect(fs.existsSync(gifPath)).toBe(true);
    });
});
