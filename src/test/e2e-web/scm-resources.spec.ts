/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test, waitForScmReady } from './standalone-fixture';

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
});
