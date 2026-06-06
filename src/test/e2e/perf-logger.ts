/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export function logPerf(message: string, startTime?: number, prefix?: string, suffix?: string): void {
    if (process.env.PERF || process.env.VERBOSE) {
        const duration = startTime !== undefined ? ` took ${Date.now() - startTime}ms` : '';
        const pref = prefix ? `${prefix} ` : '';
        const suff = suffix ? ` ${suffix}` : '';
        console.log(`[PERF] ${pref}${message}${duration}${suff}`);
    }
}
