/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { focusJJLog, test } from './e2e-helpers';

test.describe('E2E Utilities', () => {
    test('Output channel logs capture works', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        try {
            const { page } = await vscode.openWorkspace(repo);

            // Focus log to trigger extension activation and JJ commands
            await focusJJLog(page);

            // Retrieve output channel logs
            let logs = '';
            await expect(async () => {
                logs = await vscode.getOutputChannelLogs('JJ View');
                expect(logs).toContain('[RepositoryManager]');
            }).toPass({ timeout: 5000 });

            expect(logs).toContain('Total registered repositories: 1');
        } catch (err) {
            console.log('--- TEST FAILED, OUTPUT CHANNEL LOGS ---');
            console.log(await vscode.getOutputChannelLogs('JJ View'));
            console.log('----------------------------------------');
            throw err;
        }
    });

    test('Injected globalThis.waitUntil works', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        try {
            await vscode.openWorkspace(repo);

            const result = await vscode.evaluate(async () => {
                let counter = 0;
                await globalThis.waitUntil(
                    async () => {
                        counter++;
                        return counter >= 3;
                    },
                    1000,
                    50,
                );
                return counter;
            });

            expect(result).toBeGreaterThanOrEqual(3);
        } catch (err) {
            console.log('--- TEST FAILED, OUTPUT CHANNEL LOGS ---');
            console.log(await vscode.getOutputChannelLogs('JJ View'));
            console.log('----------------------------------------');
            throw err;
        }
    });

    test('Injected globalThis.logPerf works', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        try {
            await vscode.openWorkspace(repo);

            const result = await vscode.evaluate(async () => {
                const start = Date.now();
                globalThis.logPerf('Test performance log', start);
                return true;
            });

            expect(result).toBe(true);
        } catch (err) {
            console.log('--- TEST FAILED, OUTPUT CHANNEL LOGS ---');
            console.log(await vscode.getOutputChannelLogs('JJ View'));
            console.log('----------------------------------------');
            throw err;
        }
    });
});
