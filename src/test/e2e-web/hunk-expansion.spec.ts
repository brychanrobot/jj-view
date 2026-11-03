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

        // Verify outer range badges (Old and New) are removed
        await expect(additionsSeam.locator('.seam-gutter-tag')).toHaveCount(0);
        await expect(deletionsSeam.locator('.seam-gutter-tag')).toHaveCount(0);

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

        // Verify dock-pair container has overflow: hidden, padding: 0px, and non-overlapping corner radii
        const stepDownBtn = additionsSeam.locator('[data-role="step-down"]');
        await expect(stepDownBtn).toBeVisible();
        const dockProperties = await additionsSeam.evaluate((seam) => {
            const topDock = seam.querySelector<HTMLElement>('.dock-pair.dock-top');
            const bottomDock = seam.querySelector<HTMLElement>('.dock-pair.dock-bottom');
            const stepBtn = seam.querySelector<HTMLElement>('[data-role="step-down"]');
            const astBtn = seam.querySelector<HTMLElement>('[data-role="ast-down"]');
            const topDockCs = topDock ? window.getComputedStyle(topDock) : null;
            const bottomDockCs = bottomDock ? window.getComputedStyle(bottomDock) : null;
            const stepCs = stepBtn ? window.getComputedStyle(stepBtn) : null;
            const astCs = astBtn ? window.getComputedStyle(astBtn) : null;
            return {
                dockOverflow: topDockCs?.overflow,
                dockPadding: topDockCs?.padding,
                topDockTopLeft: topDockCs?.borderTopLeftRadius,
                topDockTopRight: topDockCs?.borderTopRightRadius,
                topDockBottomLeft: topDockCs?.borderBottomLeftRadius,
                topDockBottomRight: topDockCs?.borderBottomRightRadius,
                bottomDockTopLeft: bottomDockCs?.borderTopLeftRadius,
                bottomDockTopRight: bottomDockCs?.borderTopRightRadius,
                bottomDockBottomLeft: bottomDockCs?.borderBottomLeftRadius,
                bottomDockBottomRight: bottomDockCs?.borderBottomRightRadius,
                stepBorderRadius: stepCs?.borderRadius,
                astBorderRadius: astCs?.borderRadius,
            };
        });
        expect(dockProperties.dockOverflow).toBe('hidden');
        expect(dockProperties.dockPadding).toBe('0px');
        expect(dockProperties.topDockTopLeft).toBe('4px');
        expect(dockProperties.topDockTopRight).toBe('4px');
        expect(dockProperties.topDockBottomLeft).toBe('12px');
        expect(dockProperties.topDockBottomRight).toBe('12px');
        expect(dockProperties.bottomDockTopLeft).toBe('12px');
        expect(dockProperties.bottomDockTopRight).toBe('12px');
        expect(dockProperties.bottomDockBottomLeft).toBe('4px');
        expect(dockProperties.bottomDockBottomRight).toBe('4px');
        expect(dockProperties.stepBorderRadius).toBe('0px');
        expect(dockProperties.astBorderRadius).toBe('0px');

        // Verify buttons sit flush on hover
        await stepDownBtn.hover();
        const stepHoverFlush = await additionsSeam.evaluate((seam) => {
            const stepBtn = seam.querySelector<HTMLElement>('[data-role="step-down"]');
            return stepBtn ? window.getComputedStyle(stepBtn).borderRadius : null;
        });
        expect(stepHoverFlush).toBe('0px');

        // 2. AST +Block Hover Tooltip & Progressive Step-Out
        const astDownBtn = additionsSeam.locator('[data-role="ast-down"]');
        await expect(astDownBtn).toBeVisible();

        // Hover over the +Block button to reveal the tooltip
        await astDownBtn.hover();
        const astHoverFlush = await additionsSeam.evaluate((seam) => {
            const astBtn = seam.querySelector<HTMLElement>('[data-role="ast-down"]');
            return astBtn ? window.getComputedStyle(astBtn).borderRadius : null;
        });
        expect(astHoverFlush).toBe('0px');

        const topDock = additionsSeam.locator('.dock-pair.dock-top');
        const dockBox = await topDock.boundingBox();
        const stepBox = await stepDownBtn.boundingBox();
        const astBox = await astDownBtn.boundingBox();
        expect(dockBox).not.toBeNull();
        expect(stepBox).not.toBeNull();
        expect(astBox).not.toBeNull();
        if (dockBox && stepBox && astBox) {
            expect(Math.abs(stepBox.y - (dockBox.y + 1))).toBeLessThanOrEqual(1.5);
            expect(Math.abs(stepBox.height - (dockBox.height - 2))).toBeLessThanOrEqual(1.5);
            expect(Math.abs(stepBox.x - (dockBox.x + 1))).toBeLessThanOrEqual(1.5);
            expect(Math.abs(astBox.x + astBox.width - (dockBox.x + dockBox.width - 1))).toBeLessThanOrEqual(1.5);
            expect(Math.abs(astBox.x - (stepBox.x + stepBox.width))).toBeLessThanOrEqual(1.5);
        }

        const tooltip = additionsSeam.locator('.ast-tooltip.tooltip-below');
        await expect(tooltip).toBeVisible();

        const tooltipBox = await tooltip.boundingBox();
        expect(tooltipBox).not.toBeNull();
        if (dockBox && tooltipBox) {
            expect(tooltipBox.width).toBeGreaterThanOrEqual(300);
            expect(tooltipBox.height).toBeGreaterThanOrEqual(50);
            expect(tooltipBox.y).toBeGreaterThan(dockBox.y + dockBox.height);
        }

        await expect(tooltip).toContainText('BLOCK_BELOW');
        await expect(tooltip.locator('.ast-tooltip-path')).toBeVisible();
        await expect(tooltip.locator('.ast-tooltip-code')).toBeVisible();

        // Hover [data-role="ast-up"] on bottomDock and verify .ast-tooltip.tooltip-above is visible and unclipped
        const bottomDock = additionsSeam.locator('.dock-pair.dock-bottom');
        const astUpBtn = bottomDock.locator('[data-role="ast-up"]');
        await expect(astUpBtn).toBeVisible();
        await astUpBtn.hover();
        const tooltipAbove = additionsSeam.locator('.ast-tooltip.tooltip-above');
        await expect(tooltipAbove).toBeVisible();
        const bottomDockBox = await bottomDock.boundingBox();
        const tooltipAboveBox = await tooltipAbove.boundingBox();
        expect(bottomDockBox).not.toBeNull();
        expect(tooltipAboveBox).not.toBeNull();
        if (bottomDockBox && tooltipAboveBox) {
            expect(tooltipAboveBox.width).toBeGreaterThanOrEqual(300);
            expect(tooltipAboveBox.height).toBeGreaterThanOrEqual(50);
            expect(tooltipAboveBox.y + tooltipAboveBox.height).toBeLessThan(bottomDockBox.y);
        }

        await page.screenshot({
            path: path.join(OUT_DIR, 'hunk_seam_split_dark.png'),
        });

        // Re-hover astDownBtn to proceed with expansion click
        await astDownBtn.hover();
        await expect(tooltip).toBeVisible();

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

        // Verify outer range badges (Old and New) are removed in unified mode
        await expect(comboSeam.locator('.seam-gutter-tag')).toHaveCount(0);

        // Viewport resizing tests: seam remains visible and centered across mid and narrow widths
        await page.setViewportSize({ width: 880, height: 800 });
        await expect(comboSeam).toBeVisible();

        await page.setViewportSize({ width: 500, height: 800 });
        await expect(comboSeam).toBeVisible();

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

    test('expands React JSX/TSX tag blocks with progressive AST step-out in browser UI', async ({
        page,
        server,
        testRepo,
    }) => {
        const initialDashboard = [
            "import React, { useState } from 'react';",
            '',
            'export function Dashboard() {',
            "    const [status, setStatus] = useState<string>('idle');",
            '',
            '    return (',
            '        <div id="dashboard" className="dashboard-grid">',
            '            <header className="top-bar">',
            '                <h1>Analytics</h1>',
            '            </header>',
            '            <main className="content-area">',
            '                <section id="metrics" className="metrics-panel">',
            '                    <p className="status-label">Initial Status</p>',
            '                    // Metric context line 1',
            '                    // Metric context line 2',
            '                    // Metric context line 3',
            '                    // Metric context line 4',
            '                    // Metric context line 5',
            '                    // Metric context line 6',
            "                    <button onClick={() => setStatus('active')}>Activate</button>",
            '                </section>',
            '                <section id="logs" className="logs-panel">',
            '                    <p>Activity Logs</p>',
            '                    // Log context line 1',
            '                    // Log context line 2',
            '                    // Log context line 3',
            '                    // Log context line 4',
            '                    // Log context line 5',
            '                    // Log context line 6',
            '                </section>',
            '                <footer className="footer-bar">',
            '                    <p className="footer-note">Initial Footer</p>',
            '                </footer>',
            '            </main>',
            '        </div>',
            '    );',
            '}',
        ].join('\n');

        const modifiedDashboard = [
            "import React, { useState } from 'react';",
            '',
            'export function Dashboard() {',
            "    const [status, setStatus] = useState<string>('idle');",
            '',
            '    return (',
            '        <div id="dashboard" className="dashboard-grid">',
            '            <header className="top-bar">',
            '                <h1>Analytics</h1>',
            '            </header>',
            '            <main className="content-area">',
            '                <section id="metrics" className="metrics-panel">',
            '                    <p className="status-label">Updated Status Live</p>',
            '                    // Metric context line 1',
            '                    // Metric context line 2',
            '                    // Metric context line 3',
            '                    // Metric context line 4',
            '                    // Metric context line 5',
            '                    // Metric context line 6',
            "                    <button onClick={() => setStatus('active')}>Activate</button>",
            '                </section>',
            '                <section id="logs" className="logs-panel">',
            '                    <p>Activity Logs</p>',
            '                    // Log context line 1',
            '                    // Log context line 2',
            '                    // Log context line 3',
            '                    // Log context line 4',
            '                    // Log context line 5',
            '                    // Log context line 6',
            '                </section>',
            '                <footer className="footer-bar">',
            '                    <p className="footer-note">Updated Footer Live</p>',
            '                </footer>',
            '            </main>',
            '        </div>',
            '    );',
            '}',
        ].join('\n');

        testRepo.writeFile('Dashboard.tsx', initialDashboard);
        testRepo.describe('feat: initial dashboard component');
        testRepo.new();
        testRepo.writeFile('Dashboard.tsx', modifiedDashboard);

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const resourceItem = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'Dashboard.tsx' });
        await expect(resourceItem).toBeVisible();
        await resourceItem.click();

        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

        // In Dashboard.tsx, Seam 0 is the leading gap before line 9 (<header.top-bar>),
        // and Seam 1 is the intermediate gap between line 17 and line 30 (<section#metrics>)
        const leadingSeam = page.locator('.jj-hunk-seam.additions-half').first();
        const intermediateSeam = page.locator('.jj-hunk-seam.additions-half').nth(1);
        await expect(leadingSeam).toBeVisible({ timeout: 5000 });
        await expect(intermediateSeam).toBeVisible({ timeout: 5000 });

        // 1. Verify leading seam has ast-up target displaying <header.top-bar>
        const leadingAstUpBtn = leadingSeam.locator('[data-role="ast-up"]');
        await expect(leadingAstUpBtn).toBeVisible();
        await expect(leadingAstUpBtn).toContainText('<header.top-bar>');

        // 2. Verify intermediate seam has ast-down target displaying <section#metrics>
        const astDownBtn = intermediateSeam.locator('[data-role="ast-down"]');
        await expect(astDownBtn).toBeVisible();
        await expect(astDownBtn).toContainText('<section#metrics>');
        await astDownBtn.hover();

        const tooltipBelow = intermediateSeam.locator('.ast-tooltip.tooltip-below');
        await expect(tooltipBelow).toBeVisible({ timeout: 5000 });

        const tooltipPath = tooltipBelow.locator('.ast-tooltip-path');
        await expect(tooltipPath).toBeVisible();
        await expect(tooltipPath).toContainText('Dashboard()');
        await expect(tooltipPath).toContainText('<div#dashboard>');
        await expect(tooltipPath).toContainText('<section#metrics>');

        const jsxScreenshotPath = path.join(OUT_DIR, 'jsx_tag_expansion.png');
        await page.screenshot({ path: jsxScreenshotPath });

        // Click AST +Block button to expand the JSX <section#metrics> block
        await astDownBtn.click();

        // Verify context lines expand inside PierreDiffViewer
        const firstExpandedLine = diffViewer.locator('[data-line-type="context-expanded"]').first();
        await expect(firstExpandedLine).toBeVisible({ timeout: 5000 });
        const countAfterFirst = await diffViewer.locator('[data-line-type="context-expanded"]').count();
        expect(countAfterFirst).toBeGreaterThan(0);

        // Verify that the updated intermediate seam's [data-role="ast-down"] button
        // automatically steps out to the enclosing parent JSX tag <main.content-area>
        const steppedOutAstDownBtn = page.locator('.jj-hunk-seam.additions-half [data-role="ast-down"]').first();
        await expect(steppedOutAstDownBtn).toBeVisible({ timeout: 5000 });
        await expect(steppedOutAstDownBtn).toContainText('<main.content-area>');

        // Click AST +Block a second time to expand <main.content-area>
        await steppedOutAstDownBtn.click();

        // Verify that the second step-out expands more context lines
        await expect(async () => {
            const countAfterSecond = await diffViewer.locator('[data-line-type="context-expanded"]').count();
            expect(countAfterSecond).toBeGreaterThan(countAfterFirst);
        }).toPass({ timeout: 5000 });
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
