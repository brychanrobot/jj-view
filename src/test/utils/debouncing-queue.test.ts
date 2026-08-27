/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import { DebouncingQueue } from '../../utils/debouncing-queue';
import type { LoggerChannel } from '../../utils/output-channel';

describe('DebouncingQueue (Exhaustive)', () => {
    let taskFn: Mock;

    beforeEach(() => {
        vi.useFakeTimers();
        taskFn = vi.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe('Basic Debouncing & Defaults', () => {
        test('executes with default 100ms delay when no options provided', async () => {
            const queue = new DebouncingQueue(taskFn);
            queue.push();

            expect(taskFn).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(99);
            expect(taskFn).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);
            expect(taskFn).toHaveBeenCalledTimes(1);
            queue.dispose();
        });

        test('reads updated dynamic debounce delay on subsequent triggers', async () => {
            let debounceDelay = 100;
            const queue = new DebouncingQueue(taskFn, {
                getDebounceMillis: () => debounceDelay,
            });

            // 1st run with 100ms
            queue.push();
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(1);

            // Wait for quiet period so scheduler returns to idle
            await vi.advanceTimersByTimeAsync(200);

            // Change debounce delay dynamically to 300ms
            debounceDelay = 300;

            queue.push();
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(1); // Not yet (needs 300ms)

            await vi.advanceTimersByTimeAsync(200);
            expect(taskFn).toHaveBeenCalledTimes(2);
            queue.dispose();
        });

        test('reads updated max multiplier dynamically on subsequent triggers', async () => {
            let maxMultiplier = 2;
            let resolveTask: () => void = () => {};
            taskFn.mockImplementation(
                () =>
                    new Promise<void>((resolve) => {
                        resolveTask = resolve;
                    }),
            );

            const queue = new DebouncingQueue(taskFn, {
                getDebounceMillis: () => 100,
                getMaxMultiplier: () => maxMultiplier,
            });

            // 1st trigger (wait 100ms)
            queue.push();
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(1);
            resolveTask();
            await vi.advanceTimersByTimeAsync(1);

            // 2nd trigger during backoff (multiplier = 2, wait 200ms)
            queue.push();
            await vi.advanceTimersByTimeAsync(200);
            expect(taskFn).toHaveBeenCalledTimes(2);

            // Dynamically update max multiplier to 4 BEFORE execution 2 completes
            maxMultiplier = 4;
            resolveTask();
            await vi.advanceTimersByTimeAsync(1);

            // 3rd trigger (multiplier = 3, wait 300ms)
            queue.push();
            await vi.advanceTimersByTimeAsync(200);
            expect(taskFn).toHaveBeenCalledTimes(2); // Still waiting for 300ms

            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(3);
            resolveTask();
            await vi.advanceTimersByTimeAsync(1);

            queue.dispose();
        });
    });

    describe('Payload Merging & Handling', () => {
        test('merges multiple complex payloads using custom merge function', async () => {
            interface ChangePayload {
                reasons: Set<string>;
                files: string[];
                force: boolean;
            }

            const queue = new DebouncingQueue<ChangePayload>(taskFn, {
                getDebounceMillis: () => 100,
                mergePayloads: (prev, next) => ({
                    reasons: new Set([...prev.reasons, ...next.reasons]),
                    files: [...prev.files, ...next.files],
                    force: prev.force || next.force,
                }),
            });

            queue.push({ reasons: new Set(['r1']), files: ['a.txt'], force: false });
            await vi.advanceTimersByTimeAsync(30);
            queue.push({ reasons: new Set(['r2']), files: ['b.txt'], force: true });
            await vi.advanceTimersByTimeAsync(30);
            queue.push({ reasons: new Set(['r1', 'r3']), files: ['c.txt'], force: false });

            await vi.advanceTimersByTimeAsync(70);

            expect(taskFn).toHaveBeenCalledTimes(1);
            expect(taskFn).toHaveBeenCalledWith({
                reasons: new Set(['r1', 'r2', 'r3']),
                files: ['a.txt', 'b.txt', 'c.txt'],
                force: true,
            });

            queue.dispose();
        });

        test('uses last-write-wins when no merge function is provided', async () => {
            const queue = new DebouncingQueue<string>(taskFn, { getDebounceMillis: () => 100 });

            queue.push('first');
            await vi.advanceTimersByTimeAsync(40);
            queue.push('second');
            await vi.advanceTimersByTimeAsync(40);
            queue.push('third');

            await vi.advanceTimersByTimeAsync(60);

            expect(taskFn).toHaveBeenCalledTimes(1);
            expect(taskFn).toHaveBeenCalledWith('third');
            queue.dispose();
        });

        test('handles void / parameterless queue correctly', async () => {
            const queue = new DebouncingQueue(taskFn, { getDebounceMillis: () => 50 });

            queue.push();
            await vi.advanceTimersByTimeAsync(50);

            expect(taskFn).toHaveBeenCalledTimes(1);
            expect(taskFn).toHaveBeenCalledWith(undefined);
            queue.dispose();
        });
    });

    describe('flush() Behavior Across All States', () => {
        test('flush() on completely idle queue is a no-op resolving immediately', async () => {
            const queue = new DebouncingQueue(taskFn);

            await expect(queue.flush()).resolves.toBeUndefined();
            expect(taskFn).not.toHaveBeenCalled();
            queue.dispose();
        });

        test('flush() during active debounce timer cancels timer and executes immediately', async () => {
            const queue = new DebouncingQueue<string>(taskFn, { getDebounceMillis: () => 500 });

            queue.push('payload-1');
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).not.toHaveBeenCalled();

            const flushPromise = queue.flush();
            await flushPromise;
            expect(taskFn).toHaveBeenCalledTimes(1);
            expect(taskFn).toHaveBeenCalledWith('payload-1');

            // Advancing past original 500ms should not run again
            await vi.advanceTimersByTimeAsync(500);
            expect(taskFn).toHaveBeenCalledTimes(1);
            queue.dispose();
        });

        test('multiple concurrent flush() calls during timer share the same execution', async () => {
            let resolveTask: () => void = () => {};
            taskFn.mockImplementation(
                () =>
                    new Promise<void>((resolve) => {
                        resolveTask = resolve;
                    }),
            );

            const queue = new DebouncingQueue<string>(taskFn, { getDebounceMillis: () => 200 });

            queue.push('shared');
            await vi.advanceTimersByTimeAsync(50);

            const f1 = queue.flush();
            const f2 = queue.flush();
            const f3 = queue.flush();

            expect(f2).toBe(queue.currentRun);
            expect(f3).toBe(queue.currentRun);

            await Promise.resolve();
            resolveTask();
            await Promise.all([f1, f2, f3]);
            expect(taskFn).toHaveBeenCalledTimes(1);
            queue.dispose();
        });

        test('flush() while a task is in-flight queues next run immediately upon completion', async () => {
            let resolveInFlight: () => void = () => {};
            taskFn.mockImplementation(
                () =>
                    new Promise<void>((resolve) => {
                        resolveInFlight = resolve;
                    }),
            );

            const queue = new DebouncingQueue<string>(taskFn, { getDebounceMillis: () => 100 });

            // 1. Start execution 1
            queue.push('task-1');
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(1);

            // 2. While task 1 is in-flight, push task-2 and call flush()
            queue.push('task-2');
            const flushPromise = queue.flush();

            // Still only task 1 running
            expect(taskFn).toHaveBeenCalledTimes(1);

            // 3. Task 1 finishes
            resolveInFlight();
            await vi.advanceTimersByTimeAsync(1);

            // Task 2 starts immediately without waiting for a 200ms debounce delay
            expect(taskFn).toHaveBeenCalledTimes(2);
            expect(taskFn).toHaveBeenLastCalledWith('task-2');

            // Task 2 finishes
            resolveInFlight();
            await flushPromise;
            queue.dispose();
        });

        test('flush() called without new payload while task is in-flight returns in-flight promise', async () => {
            let resolveInFlight: () => void = () => {};
            taskFn.mockImplementation(
                () =>
                    new Promise<void>((resolve) => {
                        resolveInFlight = resolve;
                    }),
            );

            const queue = new DebouncingQueue(taskFn, { getDebounceMillis: () => 100 });

            // Start task 1
            queue.push();
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(1);

            // flush() with NO new pending changes
            const flushPromise = queue.flush();

            // Task 1 finishes
            resolveInFlight();
            await vi.advanceTimersByTimeAsync(1);

            await flushPromise;
            // No extra 2nd execution
            expect(taskFn).toHaveBeenCalledTimes(1);
            queue.dispose();
        });

        test('interleaved pushes and flushes during execution sequence properly', async () => {
            let resolveInFlight: () => void = () => {};
            taskFn.mockImplementation(
                () =>
                    new Promise<void>((resolve) => {
                        resolveInFlight = resolve;
                    }),
            );

            const queue = new DebouncingQueue<string[]>(taskFn, {
                getDebounceMillis: () => 100,
                mergePayloads: (prev, next) => [...prev, ...next],
            });

            // Start batch 1
            queue.push(['a']);
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(1);

            // Push b, push c, call flush()
            queue.push(['b']);
            queue.push(['c']);
            const flush1 = queue.flush();

            // Push d while still waiting for batch 1 to complete
            queue.push(['d']);

            // Batch 1 completes
            resolveInFlight();
            await vi.advanceTimersByTimeAsync(1);

            // Batch 2 runs immediately with ['b', 'c', 'd']
            expect(taskFn).toHaveBeenCalledTimes(2);
            expect(taskFn).toHaveBeenLastCalledWith(['b', 'c', 'd']);

            // Batch 2 completes
            resolveInFlight();
            await flush1;

            expect(taskFn).toHaveBeenCalledTimes(2);
            queue.dispose();
        });
    });

    describe('currentRun Tracking', () => {
        test('currentRun accurately reflects queue lifecycle states', async () => {
            let resolveInFlight: () => void = () => {};
            taskFn.mockImplementation(
                () =>
                    new Promise<void>((resolve) => {
                        resolveInFlight = resolve;
                    }),
            );

            const queue = new DebouncingQueue(taskFn, { getDebounceMillis: () => 100 });

            // 1. Idle state
            expect(queue.currentRun).toBeUndefined();

            // 2. Debounce timer ticking (pending promise active)
            const p1 = queue.push();
            expect(queue.currentRun).toBe(p1);

            // 3. Task executing (active task active)
            await vi.advanceTimersByTimeAsync(100);
            expect(queue.currentRun).toBeDefined();

            // 4. Task completes
            resolveInFlight();
            await vi.advanceTimersByTimeAsync(1);

            // 5. Returns to idle after quiet period
            await vi.advanceTimersByTimeAsync(200);
            expect(queue.currentRun).toBeUndefined();

            queue.dispose();
        });
    });

    describe('Promise Isolation & Handoff', () => {
        test('multiple push calls in same batch share the exact same promise instance', async () => {
            const queue = new DebouncingQueue<string>(taskFn, { getDebounceMillis: () => 100 });

            const p1 = queue.push('1');
            const p2 = queue.push('2');
            const p3 = queue.push('3');

            expect(p1).toBe(p2);
            expect(p2).toBe(p3);

            await vi.advanceTimersByTimeAsync(100);
            await expect(p1).resolves.toBeUndefined();
            await expect(p2).resolves.toBeUndefined();
            await expect(p3).resolves.toBeUndefined();

            queue.dispose();
        });

        test('triggers arriving during active task get a distinct promise that waits for subsequent run', async () => {
            let resolveInFlight: () => void = () => {};
            taskFn.mockImplementation(
                () =>
                    new Promise<void>((resolve) => {
                        resolveInFlight = resolve;
                    }),
            );

            const queue = new DebouncingQueue<string>(taskFn, { getDebounceMillis: () => 100 });

            // Batch 1
            const p1 = queue.push('batch-1');
            await vi.advanceTimersByTimeAsync(100); // Execution 1 starts
            expect(taskFn).toHaveBeenCalledTimes(1);

            // Batch 2 arrives during execution 1
            let p2Resolved = false;
            const p2 = queue.push('batch-2');
            p2.then(() => {
                p2Resolved = true;
            });

            expect(p2).not.toBe(p1);

            // Execution 1 finishes
            resolveInFlight();
            await vi.advanceTimersByTimeAsync(1);

            // p1 is resolved, but p2 MUST NOT be resolved yet
            await expect(p1).resolves.toBeUndefined();
            expect(p2Resolved).toBe(false);
            expect(taskFn).toHaveBeenCalledTimes(1);

            // Advance time for batch 2 backoff debounce (200ms)
            await vi.advanceTimersByTimeAsync(200);
            expect(taskFn).toHaveBeenCalledTimes(2);
            expect(taskFn).toHaveBeenLastCalledWith('batch-2');

            // Execution 2 finishes
            resolveInFlight();
            await vi.advanceTimersByTimeAsync(1);

            expect(p2Resolved).toBe(true);
            await expect(p2).resolves.toBeUndefined();

            queue.dispose();
        });
    });

    describe('Exponential Backoff & Multiplier Lifecycle', () => {
        test('scales multiplier up to max and resets to 1 after quiet period', async () => {
            const queue = new DebouncingQueue(taskFn, {
                getDebounceMillis: () => 100,
                getMaxMultiplier: () => 3,
            });

            // 1st burst: wait 100ms (multiplier = 1)
            queue.push();
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(1);

            // 2nd burst: wait 200ms (multiplier = 2)
            queue.push();
            await vi.advanceTimersByTimeAsync(199);
            expect(taskFn).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(taskFn).toHaveBeenCalledTimes(2);

            // 3rd burst: wait 300ms (multiplier = 3, capped)
            queue.push();
            await vi.advanceTimersByTimeAsync(299);
            expect(taskFn).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1);
            expect(taskFn).toHaveBeenCalledTimes(3);

            // 4th burst: wait 300ms (multiplier capped at 3)
            queue.push();
            await vi.advanceTimersByTimeAsync(300);
            expect(taskFn).toHaveBeenCalledTimes(4);

            // Quiet period: wait 300ms without new events
            await vi.advanceTimersByTimeAsync(300);

            // 5th burst after quiet period: resets to 100ms (multiplier = 1)
            queue.push();
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(5);

            queue.dispose();
        });
    });

    describe('Error Recovery & Resilience', () => {
        test('recovers from task rejection and continues processing subsequent pushes and flushes', async () => {
            taskFn.mockRejectedValueOnce(new Error('Network failure'));

            const queue = new DebouncingQueue<string>(taskFn, { getDebounceMillis: () => 100 });

            // 1. First trigger fails
            const p1 = queue.push('fail');
            const rejectAssertion = expect(p1).rejects.toThrow('Network failure');
            await vi.advanceTimersByTimeAsync(100);

            expect(taskFn).toHaveBeenCalledTimes(1);
            await rejectAssertion;

            // 2. Quiet period
            await vi.advanceTimersByTimeAsync(200);

            // 3. Subsequent push succeeds
            taskFn.mockResolvedValueOnce(undefined);
            const p2 = queue.push('success');
            await vi.advanceTimersByTimeAsync(100);

            expect(taskFn).toHaveBeenCalledTimes(2);
            expect(taskFn).toHaveBeenLastCalledWith('success');
            await expect(p2).resolves.toBeUndefined();

            // 4. Subsequent flush succeeds
            taskFn.mockResolvedValueOnce(undefined);
            queue.push('flush-success');
            const flushP = queue.flush();
            await expect(flushP).resolves.toBeUndefined();

            expect(taskFn).toHaveBeenCalledTimes(3);
            expect(taskFn).toHaveBeenLastCalledWith('flush-success');

            queue.dispose();
        });

        test('task rejection while next task is queued via flush still executes the next task', async () => {
            let rejectFirst: (err: Error) => void = () => {};
            taskFn.mockImplementationOnce(
                () =>
                    new Promise<void>((_, reject) => {
                        rejectFirst = reject;
                    }),
            );

            const queue = new DebouncingQueue<string>(taskFn, { getDebounceMillis: () => 100 });

            // Task 1 starts
            const p1 = queue.push('task-1');
            const rejectAssertion = expect(p1).rejects.toThrow('Task 1 boom');
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(1);

            // Queue task 2 via flush
            queue.push('task-2');
            const flushPromise = queue.flush();

            // Task 1 rejects
            taskFn.mockResolvedValueOnce(undefined);
            rejectFirst(new Error('Task 1 boom'));
            await vi.advanceTimersByTimeAsync(1);

            await rejectAssertion;

            // Task 2 executes cleanly
            expect(taskFn).toHaveBeenCalledTimes(2);
            expect(taskFn).toHaveBeenLastCalledWith('task-2');

            await expect(flushPromise).resolves.toBeUndefined();
            queue.dispose();
        });

        test('routes errors to optional logger when provided', async () => {
            const loggerError = vi.fn();
            const mockLogger: LoggerChannel = {
                debug: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: loggerError,
            };
            const error = new Error('Logger test error');
            taskFn.mockRejectedValueOnce(error);

            const queue = new DebouncingQueue<string>(taskFn, {
                getDebounceMillis: () => 100,
                logger: mockLogger,
            });

            const p1 = queue.push('error-task');
            const rejectAssertion = expect(p1).rejects.toThrow('Logger test error');
            await vi.advanceTimersByTimeAsync(100);

            await rejectAssertion;
            expect(loggerError).toHaveBeenCalledWith('DebouncingQueue task error:', error);
            queue.dispose();
        });

        test('wraps non-Error thrown values into Error instances for logger.error', async () => {
            const loggerError = vi.fn();
            const mockLogger: LoggerChannel = {
                debug: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: loggerError,
            };
            taskFn.mockRejectedValueOnce('string error message');

            const queue = new DebouncingQueue<string>(taskFn, {
                getDebounceMillis: () => 100,
                logger: mockLogger,
            });

            const p1 = queue.push('error-task');
            const rejectAssertion = expect(p1).rejects.toBe('string error message');
            await vi.advanceTimersByTimeAsync(100);

            await rejectAssertion;
            expect(loggerError).toHaveBeenCalledWith(
                'DebouncingQueue task error:',
                expect.objectContaining({ message: 'string error message' }),
            );
            queue.dispose();
        });
    });

    describe('Cancellation & Disposal', () => {
        test('cancel() clears debounce timer, drops pending payload, and resolves waiting promise', async () => {
            const queue = new DebouncingQueue<string>(taskFn, { getDebounceMillis: () => 100 });

            const p1 = queue.push('cancelled');
            queue.cancel();

            // Waiting promise resolves cleanly
            await expect(p1).resolves.toBeUndefined();

            // New push works normally after cancel
            queue.push('after-cancel');
            await vi.advanceTimersByTimeAsync(200);
            expect(taskFn).toHaveBeenCalledTimes(1);
            expect(taskFn).toHaveBeenCalledWith('after-cancel');

            queue.dispose();
        });

        test('cancel() resets multiplier to 1', async () => {
            const queue = new DebouncingQueue<string>(taskFn, { getDebounceMillis: () => 100 });
            queue.push('a');
            await vi.advanceTimersByTimeAsync(100); // 1st run, multiplier becomes 2
            queue.push('b');
            queue.cancel(); // resets multiplier to 1

            queue.push('c');
            await vi.advanceTimersByTimeAsync(100); // fires at 100ms (1x) rather than 200ms (2x)
            expect(taskFn).toHaveBeenCalledTimes(2);
            queue.dispose();
        });

        test('cancel() during active in-flight task preserves multiplier reset to 1 upon task completion', async () => {
            let resolveInFlight: () => void = () => {};
            taskFn.mockImplementation(
                () =>
                    new Promise<void>((resolve) => {
                        resolveInFlight = resolve;
                    }),
            );

            const queue = new DebouncingQueue<string>(taskFn, { getDebounceMillis: () => 100 });

            // 1. Start task 1
            queue.push('task-1');
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(1);

            // 2. Queue task 2 while task 1 is running
            const p2 = queue.push('task-2');

            // 3. Cancel while task 1 is in-flight
            queue.cancel();
            await expect(p2).resolves.toBeUndefined();

            // 4. Task 1 completes
            resolveInFlight();
            await vi.advanceTimersByTimeAsync(1);

            // 5. Subsequent push should use 100ms (1x multiplier), not 200ms (2x multiplier)
            queue.push('task-3');
            await vi.advanceTimersByTimeAsync(99);
            expect(taskFn).toHaveBeenCalledTimes(1); // not yet at 99ms

            await vi.advanceTimersByTimeAsync(1);
            expect(taskFn).toHaveBeenCalledTimes(2); // fired at 100ms (1x)
            expect(taskFn).toHaveBeenLastCalledWith('task-3');

            resolveInFlight();
            queue.dispose();
        });

        test('dispose() cleans up all resources and turns future calls into immediate no-ops', async () => {
            const queue = new DebouncingQueue<string>(taskFn, { getDebounceMillis: () => 100 });

            const p1 = queue.push('before-dispose');
            queue.dispose();

            await expect(p1).resolves.toBeUndefined();
            await vi.advanceTimersByTimeAsync(500);
            expect(taskFn).not.toHaveBeenCalled();

            // Future push and flush calls are no-ops
            await expect(queue.push('after-dispose')).resolves.toBeUndefined();
            await expect(queue.flush()).resolves.toBeUndefined();
            expect(taskFn).not.toHaveBeenCalled();

            // Multiple dispose calls are safe and idempotent
            expect(() => queue.dispose()).not.toThrow();
        });
    });

    describe('Re-entrancy Safety (No Deadlocks)', () => {
        test('calling push() inside task execution safely queues next batch without deadlocking', async () => {
            let insideTaskCalled = false;
            let resolveTask: () => void = () => {};

            const queue = new DebouncingQueue<string>(
                async (payload) => {
                    taskFn(payload);
                    if (payload === 'first' && !insideTaskCalled) {
                        insideTaskCalled = true;
                        // Re-entrant push during execution
                        queue.push('re-entrant');
                    }
                    await new Promise<void>((r) => {
                        resolveTask = r;
                    });
                },
                { getDebounceMillis: () => 100 },
            );

            // 1. Initial push
            queue.push('first');
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(1);
            expect(taskFn).toHaveBeenLastCalledWith('first');

            // 2. Finish task 1
            resolveTask();
            await vi.advanceTimersByTimeAsync(1);

            // 3. Advance time for re-entrant debounce window (200ms)
            await vi.advanceTimersByTimeAsync(200);

            expect(taskFn).toHaveBeenCalledTimes(2);
            expect(taskFn).toHaveBeenLastCalledWith('re-entrant');

            resolveTask();
            await vi.advanceTimersByTimeAsync(1);

            queue.dispose();
        });

        test('calling flush() inside task execution safely queues immediate execution without deadlocking', async () => {
            let resolveTask: () => void = () => {};

            const queue = new DebouncingQueue<string>(
                async (payload) => {
                    taskFn(payload);
                    if (payload === 'first') {
                        // Re-entrant flush during execution
                        queue.push('flushed-inside');
                        queue.flush();
                    }
                    await new Promise<void>((r) => {
                        resolveTask = r;
                    });
                },
                { getDebounceMillis: () => 100 },
            );

            // 1. Initial push
            queue.push('first');
            await vi.advanceTimersByTimeAsync(100);
            expect(taskFn).toHaveBeenCalledTimes(1);

            // 2. Finish task 1
            resolveTask();
            await vi.advanceTimersByTimeAsync(1);

            // Task 2 executes immediately because flush() was called inside
            expect(taskFn).toHaveBeenCalledTimes(2);
            expect(taskFn).toHaveBeenLastCalledWith('flushed-inside');

            resolveTask();
            await vi.advanceTimersByTimeAsync(1);

            queue.dispose();
        });
    });
});
