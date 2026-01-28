/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src/test/screenshots',
  timeout: 60000,
  expect: {
    timeout: 10000
  },
  reporter: 'line',
  use: {
    trace: 'on-first-retry',
  },
});
