/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import { RefreshScheduler } from '../refresh-scheduler';

const getConfigurationMock = vi.fn();

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: (...args: unknown[]) => getConfigurationMock(...args),
    },
    Disposable: class {},
}));

describe('RefreshScheduler', () => {
    let scheduler: RefreshScheduler;
    let refreshFn: Mock;

    beforeEach(() => {
        vi.useFakeTimers();
        refreshFn = vi.fn().mockResolvedValue(undefined);

        // Default config
        getConfigurationMock.mockReturnValue({
            get: (key: string, defaultValue: unknown) => {
                if (key === 'refreshDebounceMillis') {
                    return 100;
                }
                if (key === 'refreshDebounceMaxMultiplier') {
                    return 4;
                }
                return defaultValue;
            },
        });

        scheduler = new RefreshScheduler(refreshFn);
    });

    afterEach(() => {
        scheduler.dispose();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    test('should trigger refresh after base debounce time', async () => {
        scheduler.trigger();

        // Not yet
        expect(refreshFn).not.toHaveBeenCalled();

        // Advance time 100ms
        await vi.advanceTimersByTimeAsync(100);

        expect(refreshFn).toHaveBeenCalledTimes(1);
    });

    test('should debounce multiple triggers within interval', async () => {
        scheduler.trigger(); // Start timer (Wait 100)
        await vi.advanceTimersByTimeAsync(50);
        scheduler.trigger(); // Mark hasNewEvents = true
        await vi.advanceTimersByTimeAsync(50);

        // Timer fires. hasNewEvents was true.
        // It calls refresh(), increases multiplier to 2, and schedules next run (Wait 200).
        expect(refreshFn).toHaveBeenCalledTimes(1);

        // Advance 200ms (nothing new happened)
        await vi.advanceTimersByTimeAsync(200);

        // Timer fires. hasNewEvents was false.
        // Multiplier resets to 1. Loop stops.
        expect(refreshFn).toHaveBeenCalledTimes(1);
    });

    test('should obey backoff multiplier', async () => {
        // 1. First trigger: Wait 100
        scheduler.trigger();
        await vi.advanceTimersByTimeAsync(100);
        expect(refreshFn).toHaveBeenCalledTimes(1);
        // Loop continues. Multiplier = 2. Next wait = 200.

        // 2. Trigger during the 200ms wait
        scheduler.trigger();
        await vi.advanceTimersByTimeAsync(200);
        // Timer fires. Found event. Refresh. Multiplier = 3. Next wait = 300.
        expect(refreshFn).toHaveBeenCalledTimes(2);

        // 3. Trigger during the 300ms wait
        scheduler.trigger();
        await vi.advanceTimersByTimeAsync(300);
        // Timer fires. Found event. Refresh. Multiplier = 4 (Max). Next wait = 400.
        expect(refreshFn).toHaveBeenCalledTimes(3);

        // 4. Trigger during 400ms wait
        scheduler.trigger();
        await vi.advanceTimersByTimeAsync(400);
        // Timer fires. Found event. Refresh. Multiplier = 4 (Capped). Next wait = 400.
        expect(refreshFn).toHaveBeenCalledTimes(4);

        // 5. Quiet period
        await vi.advanceTimersByTimeAsync(400);
        // Timer fires. No event. Multiplier reset. Loop stop.
        expect(refreshFn).toHaveBeenCalledTimes(4);
    });

    test('should dispose correctly', async () => {
        scheduler.trigger();
        scheduler.dispose();
        await vi.advanceTimersByTimeAsync(1000);
        expect(refreshFn).not.toHaveBeenCalled();
    });

    test('trigger should return a promise that resolves after refresh completes', async () => {
        let resolved = false;
        const promise = scheduler.trigger();
        promise.then(() => {
            resolved = true;
        });

        // Not resolved yet
        expect(resolved).toBe(false);

        // Advance time to trigger refresh
        await vi.advanceTimersByTimeAsync(100);

        // Promise should now be resolved
        expect(resolved).toBe(true);
        expect(refreshFn).toHaveBeenCalledTimes(1);
    });

    test('multiple trigger calls should return the same shared promise', async () => {
        const promise1 = scheduler.trigger({ reason: 'first' });
        const promise2 = scheduler.trigger({ reason: 'second' });

        // Same promise instance
        expect(promise1).toBe(promise2);

        // Both resolve together
        let resolved1 = false;
        let resolved2 = false;
        promise1.then(() => {
            resolved1 = true;
        });
        promise2.then(() => {
            resolved2 = true;
        });

        await vi.advanceTimersByTimeAsync(100);

        expect(resolved1).toBe(true);
        expect(resolved2).toBe(true);
        expect(refreshFn).toHaveBeenCalledTimes(1);
    });

    test('trigger after previous cycle completes should return new promise', async () => {
        const promise1 = scheduler.trigger({ reason: 'first' });
        await vi.advanceTimersByTimeAsync(100);

        // First cycle complete, wait for scheduler to go idle
        await vi.advanceTimersByTimeAsync(200);

        // New trigger should get a new promise
        const promise2 = scheduler.trigger({ reason: 'second' });
        expect(promise2).not.toBe(promise1);

        await vi.advanceTimersByTimeAsync(100);
        expect(refreshFn).toHaveBeenCalledTimes(2);
    });

    test('should read updated base debounce setting dynamically on subsequent triggers', async () => {
        let currentDebounce = 100;
        getConfigurationMock.mockImplementation(() => ({
            get: (key: string, defaultValue: unknown) => {
                if (key === 'refreshDebounceMillis') {
                    return currentDebounce;
                }
                if (key === 'refreshDebounceMaxMultiplier') {
                    return 4;
                }
                return defaultValue;
            },
        }));

        // First trigger with initial debounce (100ms)
        scheduler.trigger();
        await vi.advanceTimersByTimeAsync(100);
        expect(refreshFn).toHaveBeenCalledTimes(1);

        // Wait for scheduler cycle to reset to idle
        await vi.advanceTimersByTimeAsync(200);

        // Update configuration value
        currentDebounce = 500;

        // Second trigger should use updated debounce (500ms)
        scheduler.trigger();
        await vi.advanceTimersByTimeAsync(100);
        expect(refreshFn).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(400);
        expect(refreshFn).toHaveBeenCalledTimes(2);
    });

    test('should read updated max multiplier dynamically on subsequent triggers', async () => {
        let maxMultiplier = 2;
        getConfigurationMock.mockImplementation(() => ({
            get: (key: string, defaultValue: unknown) => {
                if (key === 'refreshDebounceMillis') {
                    return 100;
                }
                if (key === 'refreshDebounceMaxMultiplier') {
                    return maxMultiplier;
                }
                return defaultValue;
            },
        }));

        // 1st trigger: wait 100ms (multiplier starts at 1, max is 2)
        scheduler.trigger();
        await vi.advanceTimersByTimeAsync(100);
        expect(refreshFn).toHaveBeenCalledTimes(1);

        // 2nd trigger during 200ms wait
        scheduler.trigger();
        await vi.advanceTimersByTimeAsync(200);
        expect(refreshFn).toHaveBeenCalledTimes(2);

        // Update max multiplier dynamically
        maxMultiplier = 4;

        // 3rd trigger during 200ms wait
        scheduler.trigger();
        await vi.advanceTimersByTimeAsync(200);
        expect(refreshFn).toHaveBeenCalledTimes(3);

        // 4th trigger: should take 300ms to fire
        scheduler.trigger();
        await vi.advanceTimersByTimeAsync(200);
        expect(refreshFn).toHaveBeenCalledTimes(3);

        await vi.advanceTimersByTimeAsync(100);
        expect(refreshFn).toHaveBeenCalledTimes(4);
    });
});
