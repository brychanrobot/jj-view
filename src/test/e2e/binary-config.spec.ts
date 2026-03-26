/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TestRepo } from '../test-repo';
import { launchVSCode } from './e2e-helpers';

test.describe('JJ Binary Configuration E2E', () => {
    test('Shows error and opens settings for invalid binary path', async () => {
        const repo = new TestRepo();
        repo.init();

        const invalidPath = path.join(os.tmpdir(), 'non-existent-jj-binary');
        const { app, page, userDataDir } = await launchVSCode(repo, {
            'jj-view.binaryPath': invalidPath,
        });

        try {
            // Un-hide notifications toast locally
            await page.addStyleTag({
                content: '.notifications-toasts { display: block !important; visibility: visible !important; }',
            });

            // Wait for notification to appear. VS Code uses a button role for notification messages sometimes,
            // or just text nodes. Let's look for the text directly.
            const notification = page.locator('.notification-toast-container', {
                hasText: `Invalid 'jj' binary configuration`,
            });
            await expect(notification).toBeVisible({ timeout: 15000 });

            const configureButton = notification.getByRole('button', { name: 'Configure Path' });
            await configureButton.click();

            // Verify settings editor is open
            await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible({ timeout: 15000 });

            // Verify the 'Binary Path' setting item is visible and has the invalid path value
            // (Standard VS Code settings verify pattern)
            const settingItem = page.locator('.setting-item').filter({ hasText: 'Binary Path' });
            await expect(settingItem).toBeVisible({ timeout: 10000 });
            await expect(settingItem.locator('input')).toHaveValue(invalidPath);
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('Shows error when jj binary is not found', async () => {
        const repo = new TestRepo();
        repo.init();

        // Launch with empty PATH and empty HOME to avoid discovery
        const { app, page, userDataDir } = await launchVSCode(
            repo,
            { 'jj-view.binaryPath': '' }, // Ensure not set
            { PATH: '', HOME: path.join(os.tmpdir(), 'jj-empty-home') },
        );

        try {
            // Un-hide notifications toast locally
            await page.addStyleTag({
                content: '.notifications-toasts { display: block !important; visibility: visible !important; }',
            });

            // Wait for notification
            const notification = page.locator('.notification-toast-container', {
                hasText: `Could not find 'jj' binary`,
            });
            await expect(notification).toBeVisible({ timeout: 15000 });

            // Click Configure Path
            const configureButton = notification.getByRole('button', { name: 'Configure Path' });
            await configureButton.click();

            // Verify settings
            await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible({ timeout: 15000 });
            const settingItem = page.locator('.setting-item').filter({ hasText: 'Binary Path' });
            await expect(settingItem).toBeVisible({ timeout: 10000 });
            // Since we set it to empty string in the setup, the UI should show an empty input
            await expect(settingItem.locator('input')).toHaveValue('');
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });
});
