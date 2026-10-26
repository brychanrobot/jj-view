/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web File Watcher', () => {
    test('should automatically detect newly created file without page reload', async ({ page, server, testRepo }) => {
        // Start with clean working copy
        testRepo.writeFile('init.txt', 'base\n');
        testRepo.describe('initial commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Verify initial working copy is empty
        const workingCopyItems = page.locator(
            '[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]',
        );
        await expect(workingCopyItems).toHaveCount(0);

        // Write a new file to disk while UI is connected
        testRepo.writeFile('watched-file.txt', 'hello from file watcher\n');

        // Verify watcher picks up the change and updates SCM pane automatically
        const newItem = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'watched-file.txt' });

        await expect(newItem).toBeVisible({ timeout: 10000 });
        await expect(newItem.locator('.status-badge')).toHaveText('A');
    });

    test('should automatically detect modified file without page reload', async ({ page, server, testRepo }) => {
        testRepo.writeFile('tracked.txt', 'original\n');
        testRepo.describe('commit tracked file');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Modify existing file on disk
        testRepo.writeFile('tracked.txt', 'modified content\n');

        const modifiedItem = page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'tracked.txt' });

        await expect(modifiedItem).toBeVisible({ timeout: 10000 });
        await expect(modifiedItem.locator('.status-badge')).toHaveText('M');
    });

    test('should refresh the log graph after an external jj operation without page reload', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('tracked.txt', 'original\n');
        testRepo.describe('before external change');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logContent = page.locator('[data-testid="log-content"]');
        await expect(logContent.getByText('before external change')).toBeVisible({ timeout: 10000 });

        // Rewrite the working-copy description from outside the UI. Only the
        // operation log changes here, so this exercises the status-change path
        // rather than the working-copy file watcher.
        testRepo.describe('after external change');

        await expect(logContent.getByText('after external change')).toBeVisible({ timeout: 10000 });
    });

    test('should refresh an open commit details view after an external jj describe', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('tracked.txt', 'original\n');
        testRepo.describe('details before external change');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logContent = page.locator('[data-testid="log-content"]');
        await logContent.getByText('details before external change').click();

        const textarea = page.locator('[data-testid="commit-details-view"] .commit-textarea');
        await expect(textarea).toHaveValue('details before external change', { timeout: 10000 });

        testRepo.describe('details after external change', '@-');

        await expect(textarea).toHaveValue('details after external change', { timeout: 10000 });
    });

    test('should refresh an open diff when the file changes on disk', async ({ page, server, testRepo }) => {
        testRepo.writeFile('tracked.txt', 'line 1\nline 2 original\nline 3\n');
        testRepo.describe('base');
        testRepo.new();
        testRepo.writeFile('tracked.txt', 'line 1\nline 2 updated\nline 3\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        await page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'tracked.txt' })
            .click();

        const diffContainer = page.locator('[data-testid="pierre-diff-viewer"] [data-testid="diff-content-container"]');
        await expect(diffContainer.getByText('line 2 updated')).toBeVisible({ timeout: 10000 });

        testRepo.writeFile('tracked.txt', 'line 1\nline 2 final\nline 3\n');

        await expect(diffContainer.getByText('line 2 final')).toBeVisible({ timeout: 10000 });
        await expect(diffContainer.getByText('line 2 updated')).toHaveCount(0);
    });

    test('should refresh an open diff after an external squash changes its base', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('tracked.txt', 'line 1\nline 2 original\nline 3\n');
        testRepo.describe('base');
        testRepo.new();
        testRepo.writeFile('tracked.txt', 'line 1\nline 2 updated\nline 3\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        await page
            .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'tracked.txt' })
            .click();

        const diffContainer = page.locator('[data-testid="pierre-diff-viewer"] [data-testid="diff-content-container"]');
        await expect(diffContainer.getByText('line 2 original')).toBeVisible({ timeout: 10000 });
        await expect(diffContainer.getByText('line 2 updated')).toBeVisible();

        // Fold the working copy into its parent, then edit again. The diff's
        // left side (`jj-view` base=@) now resolves to the squashed parent, so
        // the previously cached "line 2 original" must not survive.
        testRepo.squash();
        testRepo.writeFile('tracked.txt', 'line 1\nline 2 final\nline 3\n');

        await expect(diffContainer.getByText('line 2 final')).toBeVisible({ timeout: 10000 });
        await expect(diffContainer.getByText('line 2 updated')).toBeVisible();
        await expect(diffContainer.getByText('line 2 original')).toHaveCount(0);
    });

    test('should close a diff tab whose revision is abandoned externally', async ({ page, server, testRepo }) => {
        testRepo.writeFile('tracked.txt', 'ancestor content\n');
        testRepo.describe('ancestor commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        await page
            .locator('[data-testid="scm-group-ancestor-0"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'tracked.txt' })
            .click();

        const tabs = page.locator('[data-testid="tab-bar-container"] .tab');
        await expect(tabs).toHaveCount(1);
        await expect(
            page
                .locator('[data-testid="pierre-diff-viewer"] [data-testid="diff-content-container"]')
                .getByText('ancestor content'),
        ).toBeVisible({ timeout: 10000 });

        testRepo.abandon('@-');

        await expect(tabs).toHaveCount(0, { timeout: 10000 });
    });

    test('should refresh an open multi-file diff when a file changes on disk', async ({ page, server, testRepo }) => {
        testRepo.writeFile('tracked.txt', 'line 1\nline 2 original\nline 3\n');
        testRepo.describe('base');
        testRepo.new();
        testRepo.writeFile('tracked.txt', 'line 1\nline 2 updated\nline 3\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        await page.evaluate(() => {
            void window.__JJ_VIEW_ENV__?.commands.executeCommand('jj-view.showMultiFileDiff');
        });

        const diffContainer = page.locator(
            '[data-testid="pierre-multi-diff-viewer"] [data-testid="multi-diff-content-container"]',
        );
        await expect(diffContainer.getByText('line 2 updated')).toBeVisible({ timeout: 10000 });

        testRepo.writeFile('tracked.txt', 'line 1\nline 2 final\nline 3\n');

        await expect(diffContainer.getByText('line 2 final')).toBeVisible({ timeout: 10000 });
        await expect(diffContainer.getByText('line 2 updated')).toHaveCount(0);
    });
});
