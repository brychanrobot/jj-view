/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { JjService } from '../jj-service';
import * as cp from 'child_process';

// Mock child_process to control execution and simulate hangs
vi.mock('child_process');

describe('JjService Timeout Tests', () => {
    let jjService: JjService;

    beforeEach(() => {
        jjService = new JjService('/mock/root');
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

        const uploadPromise = jjService.upload(['git', 'push'], '@');

        // Advance 2 minutes - should still be pending (upload timeout is 6 mins)
        // We use advanceTimersByTimeAsync to ensure pending timers are processed
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
        
        let rejected = false;
        // Attach a catch handler to spy on rejection status without waiting
        uploadPromise.catch(() => { rejected = true; });
        
        // Allow any pending promises/microtasks to settle
        await new Promise(resolve => process.nextTick(resolve));
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
        newPromise.catch(() => { rejected = true; });
        await new Promise(resolve => process.nextTick(resolve));
        expect(rejected).toBe(false);

        // Advance past 1 minute
        await vi.advanceTimersByTimeAsync(31_000); // Total > 60s

        await expect(newPromise).rejects.toThrow('Mutation operation timed out after 60s');
    });
});
