/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { clickNotificationButton, expectNotificationToast, expectSettingsOpen, test } from './e2e-helpers';

test.describe('JJ Binary Configuration E2E', () => {
    test('Shows error and opens settings for invalid binary path', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();

        const invalidPath = path.join(os.tmpdir(), 'non-existent-jj-binary');
        // Open the workspace with default/valid settings first
        const { page } = await vscode.openWorkspace(repo, {}, {}, true);

        try {
            // Un-hide notifications toast locally
            await page.addStyleTag({
                content: '.notifications-toasts { display: block !important; visibility: visible !important; }',
            });

            // Clear any startup notifications (such as the disabled extensions warning)
            await vscode.executeCommand('notifications.clearAll');

            // Dynamically set the invalid binary path to trigger the toast configuration change listener
            await vscode.evaluate(async (vscode, _api, pathVal) => {
                await vscode.workspace
                    .getConfiguration('jj-view')
                    .update('binaryPath', pathVal, vscode.ConfigurationTarget.Global);
            }, invalidPath);

            // Wait for notification to appear and click 'Configure Path'
            await expectNotificationToast(page, `Invalid 'jj' binary configuration`);
            await clickNotificationButton(page, 'Configure Path');

            // Verify settings editor is open and find the Binary Path setting
            const settingItem = await expectSettingsOpen(page, 'Binary Path');
            await expect(settingItem.locator('input')).toHaveValue(invalidPath);
        } finally {
            repo.dispose();
        }
    });

    test('Shows error when jj binary is not found', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();

        // Filter PATH to exclude directories containing 'jj' so we don't crash the extension host
        // by passing an empty PATH.
        const isWin = process.platform === 'win32';
        const jjBinaryName = isWin ? 'jj.exe' : 'jj';
        const filteredPath = (process.env.PATH || '')
            .split(path.delimiter)
            .filter((p) => !fs.existsSync(path.join(p, jjBinaryName)))
            .join(path.delimiter);

        // Launch with filtered PATH and empty HOME, setting binaryPath to 'dummy' initially to avoid discovery
        const { page } = await vscode.openWorkspace(
            repo,
            { 'jj-view.binaryPath': 'dummy' },
            { PATH: filteredPath, HOME: path.join(os.tmpdir(), 'jj-empty-home') },
            true,
            true,
        );

        try {
            // Un-hide notifications toast locally
            await page.addStyleTag({
                content: '.notifications-toasts { display: block !important; visibility: visible !important; }',
            });

            // Clear any startup notifications (including the dummy path warning toast)
            await vscode.executeCommand('notifications.clearAll');

            // Trigger configuration listener by resetting binaryPath to empty string
            await vscode.evaluate(async (vscode) => {
                await vscode.workspace
                    .getConfiguration('jj-view')
                    .update('binaryPath', '', vscode.ConfigurationTarget.Global);
            });

            // Wait for notification and click 'Configure Path'
            await expectNotificationToast(page, `Could not find 'jj' binary`);
            await clickNotificationButton(page, 'Configure Path');

            // Verify settings
            const settingItem = await expectSettingsOpen(page, 'Binary Path');

            // Since we set it to empty string, the UI should show an empty input
            await expect(settingItem.locator('input')).toHaveValue('');
        } finally {
            repo.dispose();
        }
    });
});
