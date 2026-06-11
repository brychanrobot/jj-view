/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, test } from 'vitest';
import { CoalescingQueue } from '../../utils/coalescing-queue';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('CoalescingQueue', () => {
    test('runs a task when queue is idle', async () => {
        let runCount = 0;
        const queue = new CoalescingQueue(async () => {
            runCount++;
        });

        await queue.run();
        expect(runCount).toBe(1);
    });

    test('coalesces concurrent requests during active task', async () => {
        let runCount = 0;
        const resolveTasks: (() => void)[] = [];

        const queue = new CoalescingQueue(() => {
            runCount++;
            return new Promise<void>((resolve) => {
                resolveTasks.push(resolve);
            });
        });

        // Start task 1
        const p1 = queue.run();
        expect(runCount).toBe(1);

        // Queue task 2 (while task 1 is active)
        const p2 = queue.run();
        const p3 = queue.run();
        expect(runCount).toBe(1); // Task 2 has not started yet

        // Complete task 1
        resolveTasks.shift()?.();
        await p1;
        await tick(); // Allow task 2 to start

        // At this point, task 2 should have started
        expect(runCount).toBe(2);

        // Complete task 2
        resolveTasks.shift()?.();
        await p2;
        await p3;

        expect(runCount).toBe(2);
    });

    test('properly queues task 3 when requested while task 2 is running', async () => {
        let runCount = 0;
        const resolveTasks: (() => void)[] = [];

        const queue = new CoalescingQueue(() => {
            runCount++;
            return new Promise<void>((resolve) => {
                resolveTasks.push(resolve);
            });
        });

        // 1. Start task 1
        const p1 = queue.run();
        expect(runCount).toBe(1);

        // 2. Queue task 2
        const p2 = queue.run();

        // 3. Resolve task 1, starting task 2
        resolveTasks.shift()?.();
        await p1;
        await tick(); // Allow task 2 to start

        expect(runCount).toBe(2);

        // 4. While task 2 is active, request run() again. This should queue task 3!
        const p3 = queue.run();
        expect(runCount).toBe(2); // Task 3 not started yet

        // 5. Resolve task 2, starting task 3
        resolveTasks.shift()?.();
        await p2;
        await tick(); // Allow task 3 to start

        expect(runCount).toBe(3);

        // 6. Complete task 3
        resolveTasks.shift()?.();
        await p3;

        expect(runCount).toBe(3);
    });

    test('handles errors thrown by task and continues', async () => {
        let runCount = 0;
        const queue = new CoalescingQueue(async () => {
            runCount++;
            if (runCount === 1) {
                throw new Error('Task failed');
            }
        });

        await expect(queue.run()).rejects.toThrow('Task failed');
        expect(runCount).toBe(1);

        await queue.run();
        expect(runCount).toBe(2);
    });

    test('handles synchronous exceptions thrown by task', async () => {
        let runCount = 0;
        const queue = new CoalescingQueue(() => {
            runCount++;
            throw new Error('Sync Task failed');
        });

        await expect(queue.run()).rejects.toThrow('Sync Task failed');
        expect(runCount).toBe(1);
        expect(queue.currentRun).toBeUndefined();

        // Check that subsequent runs are still handled correctly
        const queue2 = new CoalescingQueue(async () => {
            runCount++;
        });
        await queue2.run();
        expect(runCount).toBe(2);
    });

    test('queues subsequent run request while a synchronous error run is settling', async () => {
        let runCount = 0;
        let shouldThrow = true;
        const queue = new CoalescingQueue(() => {
            runCount++;
            if (shouldThrow) {
                throw new Error('Sync Task failed');
            }
            return Promise.resolve();
        });

        // 1. Start task 1 (which throws synchronously)
        const p1 = queue.run();
        expect(runCount).toBe(1);

        // 2. Queue task 2 (before p1 settles/rejects in the microtask loop)
        shouldThrow = false;
        const p2 = queue.run();

        // Task 2 should not have run yet since task 1's promise has not settled
        expect(runCount).toBe(1);

        // 3. Let task 1 settle and task 2 run
        await expect(p1).rejects.toThrow('Sync Task failed');
        await p2;

        // Task 2 should have run and completed
        expect(runCount).toBe(2);
    });
});
