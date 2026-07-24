/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../jj-service';

// Mock child_process to control execution and simulate hangs
vi.mock('child_process');

describe('JjService Timeout Tests', () => {
    let jjService: JjService;

    beforeEach(() => {
        jjService = new JjService('/mock/root', NO_OP_LOGGER);
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    test('upload command uses 6 minute timeout', async () => {
        // Mock execFile to never call callback (simulate hang)
        // We don't call the callback, so the promise stays pending until timeout
        vi.mocked(cp.execFile).mockImplementation(() => {
            return {} as cp.ChildProcess;
        });

        const uploadPromise = jjService.upload('@', 'git', 'push');

        // Advance 2 minutes - should still be pending (upload timeout is 6 mins)
        // We use advanceTimersByTimeAsync to ensure pending timers are processed
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

        let rejected = false;
        // Attach a catch handler to spy on rejection status without waiting
        uploadPromise.catch(() => {
            rejected = true;
        });

        // Allow any pending promises/microtasks to settle
        await new Promise((resolve) => process.nextTick(resolve));
        expect(rejected).toBe(false);

        // Advance past 6 minutes (total time)
        // We already advanced 2 mins, so advance 4 mins + 100ms
        await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 100);

        await expect(uploadPromise).rejects.toThrow('Mutation operation timed out after 360s');
    });

    test('other mutations use 1 minute timeout', async () => {
        vi.mocked(cp.execFile).mockImplementation(() => {
            return {} as cp.ChildProcess;
        });

        const newPromise = jjService.new({ message: 'test' });

        // Advance 30s - should be fine
        await vi.advanceTimersByTimeAsync(30_000);

        let rejected = false;
        newPromise.catch(() => {
            rejected = true;
        });
        await new Promise((resolve) => process.nextTick(resolve));
        expect(rejected).toBe(false);

        // Advance past 1 minute
        await vi.advanceTimersByTimeAsync(31_000); // Total > 60s

        await expect(newPromise).rejects.toThrow('Mutation operation timed out after 60s');
    });

    test('read operations use 2 minute timeout', async () => {
        vi.mocked(cp.execFile).mockImplementation(() => {
            return {} as cp.ChildProcess;
        });

        const readPromise = jjService.getRepoRoot();

        // Advance 1 minute - should still be pending
        await vi.advanceTimersByTimeAsync(60_000);

        let rejected = false;
        readPromise.catch(() => {
            rejected = true;
        });
        await new Promise((resolve) => process.nextTick(resolve));
        expect(rejected).toBe(false);

        // Advance past 2 minutes (total > 120s)
        await vi.advanceTimersByTimeAsync(61_000);

        await expect(readPromise).rejects.toThrow('Read operation timed out after 120s');
    });

    test('clears timeout timer on read operation completion', async () => {
        const warnSpy = vi.fn();
        const logger = { ...NO_OP_LOGGER, warn: warnSpy };
        const service = new JjService('/mock/root', logger);

        vi.mocked(cp.execFile).mockImplementation((_cmd, _args, _opts, callback) => {
            if (typeof callback === 'function') {
                callback(null, '/mock/root', '');
            }
            return {} as cp.ChildProcess;
        });

        const result = await service.getRepoRoot();
        expect(result).toBe('/mock/root');

        // Advance fake timers by 3 minutes (past the 2-minute read timeout)
        await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

        // Verify that logger.warn was never called with a timeout message
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('reads timeout duration from getConfig callback', async () => {
        vi.mocked(cp.execFile).mockImplementation(() => {
            return {} as cp.ChildProcess;
        });

        const getConfig = vi.fn().mockImplementation((key: string, defaultValue?: unknown) => {
            if (key === 'readTimeoutSeconds') {
                return 15;
            }
            return defaultValue;
        });

        const service = new JjService('/mock/root', NO_OP_LOGGER, { getConfig });
        const readPromise = service.getRepoRoot();

        // Advance 10s - should be pending
        await vi.advanceTimersByTimeAsync(10_000);

        let rejected = false;
        readPromise.catch(() => {
            rejected = true;
        });
        await new Promise((resolve) => process.nextTick(resolve));
        expect(rejected).toBe(false);

        // Advance past 15s (total 16s)
        await vi.advanceTimersByTimeAsync(6000);

        await expect(readPromise).rejects.toThrow('Read operation timed out after 15s');
        expect(getConfig).toHaveBeenCalledWith('readTimeoutSeconds', 120);
    });
});
