/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Commit Flow', () => {
    test('should commit working copy changes with message when clicking Commit button', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile('app.ts', 'console.log("hello");\n');
        testRepo.describe('initial commit');
        testRepo.new();

        testRepo.writeFile('app.ts', 'console.log("hello world!");\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Verify working copy has 1 file
        const wcItems = page.locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]');
        await expect(wcItems).toHaveCount(1);

        // Fill commit message in textarea
        const textarea = page.locator('[data-testid="scm-input-textarea"]');
        await textarea.fill('feat: update greeting message');

        // Click Commit button in SCM header toolbar
        const commitBtn = page.locator('[data-testid="scm-title-action-jj-view.commit"]');
        await expect(commitBtn).toBeVisible();
        await commitBtn.click();

        // Verify working copy becomes clean and textarea is cleared
        await expect(wcItems).toHaveCount(0, { timeout: 10000 });
        await expect(textarea).toHaveValue('');

        // Verify the commit description in Jujutsu
        await expect
            .poll(() => testRepo.getDescription('@-'), { timeout: 10000 })
            .toContain('feat: update greeting message');
    });

    test('should commit working copy changes via Ctrl+Enter shortcut', async ({ page, server, testRepo }) => {
        testRepo.writeFile('config.json', '{"version": 1}\n');
        testRepo.describe('base config');
        testRepo.new();

        testRepo.writeFile('config.json', '{"version": 2}\n');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const wcItems = page.locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]');
        await expect(wcItems).toHaveCount(1);

        const textarea = page.locator('[data-testid="scm-input-textarea"]');
        await textarea.focus();
        await textarea.fill('chore: bump version to 2');

        // Press Ctrl+Enter to commit
        await page.keyboard.press('Control+Enter');

        // Verify working copy becomes clean and textarea is cleared
        await expect(wcItems).toHaveCount(0, { timeout: 10000 });
        await expect(textarea).toHaveValue('');

        await expect
            .poll(() => testRepo.getDescription('@-'), { timeout: 10000 })
            .toContain('chore: bump version to 2');
    });

    test('should update working copy description via Ctrl+S shortcut', async ({ page, server, testRepo }) => {
        testRepo.writeFile('draft.txt', 'draft work\n');
        testRepo.describe('initial commit');
        testRepo.new();

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const textarea = page.locator('[data-testid="scm-input-textarea"]');
        await textarea.focus();
        await textarea.fill('wip: working on draft feature');

        // Press Ctrl+S on textarea to update description without committing
        await page.keyboard.press('Control+s');

        // Verify description updated in Jujutsu without creating a new commit
        await expect
            .poll(() => testRepo.getDescription('@'), { timeout: 10000 })
            .toContain('wip: working on draft feature');
    });
});
