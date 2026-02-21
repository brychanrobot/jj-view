/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as cp from 'child_process';
import { JjService } from '../jj-service';

vi.mock('child_process');

describe('JjService Write Operation Timeout', () => {
    let jjService: JjService;
    let logs: string[] = [];

    beforeEach(() => {
        vi.useFakeTimers();
        logs = [];
        jjService = new JjService('/fake/path', (msg) => logs.push(msg));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    test('hasActiveWriteOps reflects pending mutation operations', async () => {
        let resolveCommand: (value: string) => void;
        const hangingPromise = new Promise<string>((r) => {
            resolveCommand = r;
        });

        vi.mocked(cp.execFile).mockImplementation(
            (_cmd, _args, _opts, callback) => {
                // Don't call callback immediately - simulate hanging command
                hangingPromise.then(() => {
                    callback!(null, 'done', '');
                });
                return {} as cp.ChildProcess;
            },
        );

        expect(jjService.hasActiveWriteOps).toBe(false);

        // Start a mutation operation
        const abandonPromise = jjService.abandon('test-rev');

        // Should now have active write ops
        expect(jjService.hasActiveWriteOps).toBe(true);
        expect(jjService.writeOpCount).toBe(1);

        // Resolve the command
        resolveCommand!('done');
        await abandonPromise;

        // Should be cleared
        expect(jjService.hasActiveWriteOps).toBe(false);
        expect(jjService.writeOpCount).toBe(0);
    });

    test('timeout rejects promise and unblocks file watcher after 60 seconds', async () => {
        // Mock a command that never completes
        vi.mocked(cp.execFile).mockImplementation(() => {
            // Never calls callback - simulates hanging command
            return {} as cp.ChildProcess;
        });

        expect(jjService.hasActiveWriteOps).toBe(false);

        // Start a mutation that will hang - capture the promise
        const abandonPromise = jjService.abandon('test-rev');

        expect(jjService.hasActiveWriteOps).toBe(true);
        expect(jjService.writeOpCount).toBe(1);

        // Attach rejection handler BEFORE advancing time to prevent unhandled rejection
        let rejectionError: Error | undefined;
        abandonPromise.catch((e: Error) => {
            rejectionError = e;
        });

        // Advance time to just before timeout
        await vi.advanceTimersByTimeAsync(59_000);
        expect(jjService.hasActiveWriteOps).toBe(true);

        // Advance past timeout (60 seconds) - this will trigger rejection
        await vi.advanceTimersByTimeAsync(2_000);

        // Verify the rejection occurred
        expect(rejectionError?.message).toContain('timed out');

        // .finally() should have cleaned up
        expect(jjService.hasActiveWriteOps).toBe(false);
        expect(jjService.writeOpCount).toBe(0);
    });

    test('completed operation clears timeout without double-decrementing', async () => {
        let resolveCommand: () => void;

        vi.mocked(cp.execFile).mockImplementation(
            (_cmd, _args, _opts, callback) => {
                // Will resolve when we call resolveCommand
                new Promise<void>((r) => {
                    resolveCommand = r;
                }).then(() => callback!(null, 'done', ''));
                return {} as cp.ChildProcess;
            },
        );

        const abandonPromise = jjService.abandon('test-rev');
        expect(jjService.writeOpCount).toBe(1);

        // Wait a microtask for the mutex queue to pulse and runInternal to start
        await Promise.resolve();

        // Complete before timeout
        resolveCommand!();
        await abandonPromise;

        expect(jjService.writeOpCount).toBe(0);

        // Advance past what would have been the timeout
        await vi.advanceTimersByTimeAsync(70_000);

        // Should still be 0, not negative (no double-decrement)
        expect(jjService.writeOpCount).toBe(0);
    });
});
