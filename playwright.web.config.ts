/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './src/test/e2e-web',
    testMatch: /.*\.spec\.ts/,
    timeout: 60000,
    expect: {
        timeout: 10000,
    },
    reporter: [['list'], ['html', { open: 'never' }]],
    outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results',
    use: {
        headless: true,
        launchOptions: {
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
        actionTimeout: 10000,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
});
