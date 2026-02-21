/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/test/**/*.test.ts'],
        exclude: ['src/test/**/*.integration.test.ts'], // Exclude integration tests
        globals: true,
        testTimeout: 20000,
        hookTimeout: 20000,
    },
});
