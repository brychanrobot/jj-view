/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { VitestPerfReporter } from './tooling/vitest-perf-reporter';

const isWindows = process.platform === 'win32';
const traceFile = path.join(os.tmpdir(), `jj-view-perf-trace-${process.pid}.jsonl`);

export default defineConfig({
    plugins: [svelte()],
    test: {
        include: ['src/test/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'],
        exclude: ['src/test/**/*.integration.test.ts'], // Exclude integration tests
        // Temporary global setup to provide vscode mock during host abstraction retrofit
        setupFiles: ['./src/test/vitest-setup.ts'],
        globals: true,
        env: {
            JJ_VIEW_PERF_TRACE_FILE: traceFile,
        },
        reporters: ['default', new VitestPerfReporter(traceFile)],
        testTimeout: isWindows ? 60000 : 20000,
        hookTimeout: isWindows ? 60000 : 20000,
        retry: isWindows && process.env.CI ? 1 : 0,
        maxWorkers: isWindows && process.env.CI ? 2 : undefined,
        execArgv: ['--max-old-space-size=4096'],
    },
});
