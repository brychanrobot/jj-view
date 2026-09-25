/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, waitForScmReady } from './standalone-fixture';

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
        await expect(diffViewer.locator('.file-name')).toContainText('file2.txt');

        // Verify diff content contains the file content
        const diffContainer = diffViewer.locator('[data-testid="diff-content-container"]');
        await expect(diffContainer).toBeVisible();
        await expect(diffContainer.getByText('commit 2 original')).toBeVisible({ timeout: 5000 });
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
});
