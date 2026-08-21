/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AsyncEventEmitter } from '../utils/async-event-emitter';
import { CoalescingQueue } from '../utils/coalescing-queue';
import { DebouncingQueue } from '../utils/debouncing-queue';
import { FakeConfigStore } from './test-utils';

let fakeConfigStore: FakeConfigStore;

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock({
        workspace: {
            getConfiguration: () => fakeConfigStore.toWorkspaceConfiguration(),
        },
    });
});

describe('Refresh Pipeline Cleanup & Error Recovery', () => {
    beforeEach(() => {
        fakeConfigStore = new FakeConfigStore({
            refreshDebounceMillis: 50,
            refreshDebounceMaxMultiplier: 2,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    test('AsyncEventEmitter fires all listeners safely even if one throws an error', async () => {
        const emitter = new AsyncEventEmitter<{ reason: string }>();
        const executed: string[] = [];

        emitter.event(async (evt) => {
            executed.push(`l1:${evt.reason}`);
            throw new Error('Listener 1 failed');
        });

        emitter.event(async (evt) => {
            executed.push(`l2:${evt.reason}`);
        });

        await expect(emitter.fire({ reason: 'manual' })).resolves.toBeUndefined();
        expect(executed).toEqual(['l1:manual', 'l2:manual']);
    });

    test('CoalescingQueue executes queued tasks sequentially even when active task rejects', async () => {
        let executionCount = 0;
        const taskLogs: string[] = [];

        const queue = new CoalescingQueue(async () => {
            executionCount++;
            taskLogs.push(`run-${executionCount}`);
            if (executionCount === 1) {
                throw new Error('Task 1 error');
            }
        });

        const p1 = queue.run();
        const p2 = queue.run();

        await expect(p1).rejects.toThrow('Task 1 error');
        await expect(p2).resolves.toBeUndefined();

        expect(taskLogs).toEqual(['run-1', 'run-2']);
    });

    test('DebouncingQueue recovers from failed task without locking future triggers', async () => {
        vi.useFakeTimers();

        let callCount = 0;
        const queue = new DebouncingQueue<{ reason: string }>(
            async () => {
                callCount++;
                if (callCount === 1) {
                    throw new Error('First callback failure');
                }
            },
            { getDebounceMillis: () => 50 },
        );

        // 1st trigger fails
        const p1 = queue.push({ reason: 'r1' });
        const rejectAssertion = expect(p1).rejects.toThrow('First callback failure');
        await vi.advanceTimersByTimeAsync(50);
        await rejectAssertion;
        expect(callCount).toBe(1);

        // Quiet period to let queue reset to idle
        await vi.advanceTimersByTimeAsync(100);

        // 2nd trigger should execute cleanly
        const p2 = queue.push({ reason: 'r2' });
        await vi.advanceTimersByTimeAsync(50);
        await expect(p2).resolves.toBeUndefined();
        expect(callCount).toBe(2);

        queue.dispose();
    });
});
