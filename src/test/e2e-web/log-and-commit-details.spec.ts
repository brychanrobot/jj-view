/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { ROOT_ID } from '../test-repo';
import { ARTIFACT_DIR, expect, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Log and Commit Details', () => {
    test('should display log graph, select commit, open commit details, and click file diff', async ({
        page,
        server,
        testRepo,
    }) => {
        // Set up commits with descriptions and files
        testRepo.writeFile('file1.txt', 'commit 1 contents\n');
        testRepo.describe('feat: initial commit');
        testRepo.new();

        testRepo.writeFile('file2.txt', 'commit 2 original\n');
        testRepo.describe('feat: add second file');
        testRepo.new();

        testRepo.writeFile('file2.txt', 'commit 2 updated\n');
        testRepo.describe('fix: update second file');
        testRepo.writeFile('file3.txt', 'working copy uncommitted\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // 1. Verify Log Pane is visible below SCM pane
        const logPane = page.locator('[data-testid="log-pane"]');
        await expect(logPane).toBeVisible({ timeout: 10000 });

        // 2. Verify graph nodes and descriptions are rendered in JJ Log
        const logContent = page.locator('[data-testid="log-content"]');
        await expect(logContent).toBeVisible();

        // Wait for commit rows to render
        const commitRows = logContent.locator('.commit-row');
        await expect(commitRows.first()).toBeVisible({ timeout: 10000 });
        await expect(commitRows).toHaveCount(4);

        // Verify descriptions in log graph
        await expect(logContent.getByText('feat: add second file')).toBeVisible();
        await expect(logContent.getByText('feat: initial commit')).toBeVisible();

        // 3. Click the description of the second commit ('feat: add second file')
        const targetRow = logContent.locator('.commit-row').filter({ hasText: 'feat: add second file' });
        await targetRow.locator('.commit-desc').click();

        // 4. Verify Commit Details pane is mounted in main editor view
        const detailsView = page.locator('[data-testid="commit-details-view"]');
        await expect(detailsView).toBeVisible({ timeout: 5000 });

        // Verify commit details header & description
        await expect(detailsView.locator('.commit-textarea')).toHaveValue('feat: add second file');

        // Verify author metadata is rendered
        await expect(detailsView.locator('.people-rows')).toBeVisible();

        // Verify changed files list contains 'file2.txt'
        const fileRow = detailsView.locator('.file-row').filter({ hasText: 'file2.txt' });
        await expect(fileRow).toBeVisible();

        // Verify consistent typography and foreground colors between SCM, Log, and Commit Details
        const scmItem = page.locator('[data-testid="scm-resource-item"]').first();
        await expect(scmItem).toBeVisible();
        const scmFontSize = await scmItem.evaluate((el) => window.getComputedStyle(el).fontSize);
        const logDesc = targetRow.locator('.commit-desc');
        const logFontSize = await logDesc.evaluate((el) => window.getComputedStyle(el).fontSize);
        expect(scmFontSize).toBe('13px');
        expect(logFontSize).toBe('13px');

        const scmFileName = scmItem.locator('.file-name');
        const scmColor = await scmFileName.evaluate((el) => window.getComputedStyle(el).color);
        const logColor = await logDesc.evaluate((el) => window.getComputedStyle(el).color);
        const detailsFileName = fileRow.locator('.file-name');
        const detailsColor = await detailsFileName.evaluate((el) => window.getComputedStyle(el).color);
        expect(scmColor).toBe(detailsColor);
        expect(logColor).toBe(detailsColor);

        // Verify description foreground has muted contrast in Commit Details
        const authorLabel = detailsView.locator('.people-rows .label').first();
        const labelColor = await authorLabel.evaluate((el) => window.getComputedStyle(el).color);
        expect(labelColor).not.toBe(detailsColor);

        // 5. Click the changed file in Commit Details to open its diff
        await fileRow.click();

        // Verify Pierre Diff Viewer opens
        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
        await expect(diffViewer).toBeVisible({ timeout: 5000 });
        const activeTab = page.locator('[data-testid="tab-bar-container"] .tab.active');
        await expect(activeTab).toContainText('file2.txt');

        // Verify diff content contains the file content
        const diffContainer = diffViewer.locator('[data-testid="diff-content-container"]');
        await expect(diffContainer).toBeVisible();
        await expect(diffContainer.getByText('commit 2 original')).toBeVisible({ timeout: 5000 });
    });

    test('should replace the contents of the preview details tab when another commit is clicked', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('first.txt', 'first\n');
        testRepo.describe('feat: first commit');
        testRepo.new();
        testRepo.writeFile('second.txt', 'second\n');
        testRepo.describe('feat: second commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logContent = page.locator('[data-testid="log-content"]');
        const detailsView = page.locator('[data-testid="commit-details-view"]');
        const tabs = page.locator('[data-testid="tab-bar-container"] .tab');

        await logContent
            .locator('.commit-row')
            .filter({ hasText: 'feat: first commit' })
            .locator('.commit-desc')
            .click();
        await expect(detailsView.locator('.commit-textarea')).toHaveValue('feat: first commit', { timeout: 10000 });
        await expect(detailsView.locator('.file-row').filter({ hasText: 'first.txt' })).toBeVisible();
        await expect(tabs).toHaveCount(1);
        const firstTabTitle = await tabs.first().innerText();

        // Clicking another commit reuses the preview tab. The tab title and
        // the rendered details must both move to the new commit.
        await logContent
            .locator('.commit-row')
            .filter({ hasText: 'feat: second commit' })
            .locator('.commit-desc')
            .click();
        await expect(tabs).toHaveCount(1);
        await expect(tabs.first()).not.toHaveText(firstTabTitle);
        await expect(detailsView.locator('.commit-textarea')).toHaveValue('feat: second commit', { timeout: 10000 });
        await expect(detailsView.locator('.file-row').filter({ hasText: 'second.txt' })).toBeVisible();
        await expect(detailsView.locator('.file-row').filter({ hasText: 'first.txt' })).toHaveCount(0);
    });

    test('should keep an edited description draft in its own tab when another commit is opened', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('first.txt', 'first\n');
        testRepo.describe('feat: first commit');
        testRepo.new();
        testRepo.writeFile('second.txt', 'second\n');
        testRepo.describe('feat: second commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logContent = page.locator('[data-testid="log-content"]');
        const textarea = page.locator('[data-testid="commit-details-view"] .commit-textarea');
        const tabs = page.locator('[data-testid="tab-bar-container"] .tab');

        await logContent
            .locator('.commit-row')
            .filter({ hasText: 'feat: first commit' })
            .locator('.commit-desc')
            .click();
        await expect(textarea).toHaveValue('feat: first commit', { timeout: 10000 });
        await expect(tabs.first()).toHaveClass(/preview/);

        // Editing the description marks the tab dirty and pins it.
        await textarea.fill('feat: first commit (draft)');
        await expect(tabs.first()).toHaveClass(/dirty/);
        await expect(tabs.first()).not.toHaveClass(/preview/);

        // The next commit therefore opens in a second tab instead of
        // replacing the one holding the draft.
        await logContent
            .locator('.commit-row')
            .filter({ hasText: 'feat: second commit' })
            .locator('.commit-desc')
            .click();
        await expect(tabs).toHaveCount(2);
        await expect(textarea).toHaveValue('feat: second commit', { timeout: 10000 });

        // Switching back shows the draft, not a reloaded description.
        await tabs.first().click();
        await expect(textarea).toHaveValue('feat: first commit (draft)');
    });

    test('should render colorful graph lanes and allow vertical scrolling for long log history', async ({
        page,
        server,
        testRepo,
    }) => {
        // Create 20 revisions to ensure the log history overflows the viewport
        for (let i = 1; i <= 20; i++) {
            testRepo.writeFile('log-scroll-test.txt', `revision ${i} line\n`);
            testRepo.describe(`feat: commit number ${i} for scrolling`);
            if (i < 20) {
                testRepo.new();
            }
        }

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logPane = page.locator('[data-testid="log-pane"]');
        await expect(logPane).toBeVisible({ timeout: 10000 });

        const logContent = page.locator('[data-testid="log-content"]');
        await expect(logContent).toBeVisible();

        const scrollContainer = logContent.locator('.scroll-container');
        await expect(scrollContainer).toBeVisible();

        // Verify commit rows are rendered
        const commitRows = logContent.locator('.commit-row');
        await expect(commitRows.first()).toBeVisible({ timeout: 10000 });
        const rowCount = await commitRows.count();
        expect(rowCount).toBeGreaterThanOrEqual(20);

        // Verify graph circles are colored with CSS lane variables
        const graphCircles = logContent.locator('.graph-svg [data-commit-id] circle');
        await expect(graphCircles.first()).toBeVisible();
        const circleCount = await graphCircles.count();
        expect(circleCount).toBeGreaterThan(0);

        // Verify circles use lane color variable (e.g. var(--jj-lane-0))
        const hasLaneColor = await graphCircles.evaluateAll((circles) =>
            circles.some((el) => {
                const fill = el.getAttribute('fill') || '';
                const stroke = el.getAttribute('stroke') || '';
                return fill.includes('--jj-lane-') || stroke.includes('--jj-lane-');
            }),
        );
        expect(hasLaneColor).toBe(true);

        // Verify scrollability: scrollHeight exceeds clientHeight
        const isScrollable = await scrollContainer.evaluate((el) => el.scrollHeight > el.clientHeight);
        expect(isScrollable).toBe(true);

        // Scroll down
        await scrollContainer.evaluate((el) => {
            el.scrollTop = 300;
        });

        // Verify scrollTop changed
        const scrollTop = await scrollContainer.evaluate((el) => el.scrollTop);
        expect(scrollTop).toBeGreaterThan(0);
    });

    test('renders root() cleanly, does not open Commit Details for root, and hides diff/duplicate menu items', async ({
        page,
        server,
        testRepo,
    }) => {
        const pageErrors: Error[] = [];
        page.on('pageerror', (err) => {
            if (err.message.includes('agentapi failed') || err.message.includes('agentapi binary not found')) {
                return;
            }
            pageErrors.push(err);
        });

        testRepo.config('revsets.log', 'all()');
        testRepo.writeFile('app.txt', 'hello\n');
        testRepo.describe('feat: normal commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logContent = page.locator('[data-testid="log-content"]');
        const rootRow = logContent.locator(`.commit-row[data-change-id="${ROOT_ID}"]`);
        await expect(rootRow).toBeVisible({ timeout: 10000 });

        // Root commit displays `root()` rather than `(empty) (no description)`
        const rootDesc = rootRow.locator('.commit-desc');
        await expect(rootDesc).toHaveText('root()');
        await expect(rootRow).not.toContainText('(empty)');
        await expect(rootRow).not.toContainText('(no description)');

        // Graph node renders a solid diamond <polygon> filled with lane color
        const rootPolygon = logContent.locator(
            `.graph-svg g[data-commit-id="0000000000000000000000000000000000000000"] polygon`,
        );
        await expect(rootPolygon).toBeVisible();
        await expect(rootPolygon).toHaveAttribute('fill', /--jj-lane-/);

        // Clicking root commit does not open Commit Details
        const detailsView = page.locator('[data-testid="commit-details-view"]');
        const tabs = page.locator('[data-testid="tab-bar-container"] .tab');
        await rootRow.click();
        await expect(rootRow).toHaveAttribute('aria-selected', 'true');
        await expect(detailsView).toHaveCount(0);
        await expect(tabs).toHaveCount(0);

        const normalRow = logContent.locator('.commit-row').filter({ hasText: 'feat: normal commit' });
        await expect(rootRow).not.toHaveAttribute('data-draggable', 'true');
        await expect(normalRow).toHaveAttribute('data-draggable', 'true');

        // Attempting to drag root() does not activate drag preview
        const rootBox = await rootRow.boundingBox();
        const normalBox = await normalRow.boundingBox();
        expect(rootBox).not.toBeNull();
        expect(normalBox).not.toBeNull();
        if (rootBox && normalBox) {
            await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2);
            await page.mouse.down();
            await page.mouse.move(normalBox.x + normalBox.width / 2, normalBox.y + normalBox.height / 2, { steps: 5 });
            await expect(page.locator('.drag-preview-overlay')).toHaveCount(0);
            await page.mouse.up();
        }

        // Open Commit Details on a normal commit, then click root() — existing details remain intact
        await normalRow.locator('.commit-desc').click();
        await expect(detailsView).toBeVisible({ timeout: 10000 });
        await expect(detailsView.locator('.commit-textarea')).toHaveValue('feat: normal commit');
        await expect(tabs).toHaveCount(1);

        await rootRow.click();
        await expect(rootRow).toHaveAttribute('aria-selected', 'true');
        await expect(tabs).toHaveCount(1);
        await expect(detailsView.locator('.commit-textarea')).toHaveValue('feat: normal commit');

        // Right-clicking root commit hides Show Multi-File Diff and Duplicate while keeping New
        await rootRow.click({ button: 'right' });
        const contextMenu = page.locator('[data-testid="context-menu"]');
        await expect(contextMenu).toBeVisible();
        await expect(page.locator('[data-testid="menu-item-jj-view.showMultiFileDiff"]')).toHaveCount(0);
        await expect(page.locator('[data-testid="menu-item-jj-view.duplicate"]')).toHaveCount(0);
        await expect(page.locator('[data-testid="menu-item-jj-view.new"]')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(contextMenu).toHaveCount(0);

        // Capture dark & light theme screenshots of the log pane with root()
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'root-commit-log-dark.png') });
        await page.evaluate(async () => {
            await window.__JJ_VIEW_ENV__?.config.update?.('appearance.theme', 'pierre-light');
        });
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'pierre-light');
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'root-commit-log-light.png') });

        expect(pageErrors).toEqual([]);
    });
});
