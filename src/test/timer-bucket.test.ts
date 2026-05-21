/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TimerBucket } from '../utils/timer-bucket';

describe('TimerBucket', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('fires callback after the specified delay', () => {
        const bucket = new TimerBucket();
        const cb = vi.fn();

        bucket.schedule(cb, 1000);
        expect(cb).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1000);
        expect(cb).toHaveBeenCalledOnce();
    });

    test('tracks pending timers via size', () => {
        const bucket = new TimerBucket();
        expect(bucket.size).toBe(0);

        bucket.schedule(() => {}, 1000);
        bucket.schedule(() => {}, 2000);
        expect(bucket.size).toBe(2);

        vi.advanceTimersByTime(1000);
        expect(bucket.size).toBe(1); // first timer fired and removed itself

        vi.advanceTimersByTime(1000);
        expect(bucket.size).toBe(0);
    });

    test('dispose cancels all pending timers', () => {
        const bucket = new TimerBucket();
        const cb1 = vi.fn();
        const cb2 = vi.fn();

        bucket.schedule(cb1, 1000);
        bucket.schedule(cb2, 2000);
        expect(bucket.size).toBe(2);

        bucket.dispose();
        expect(bucket.size).toBe(0);

        vi.advanceTimersByTime(5000);
        expect(cb1).not.toHaveBeenCalled();
        expect(cb2).not.toHaveBeenCalled();
    });

    test('dispose can be called multiple times safely', () => {
        const bucket = new TimerBucket();
        bucket.schedule(() => {}, 1000);

        expect(() => {
            bucket.dispose();
            bucket.dispose();
        }).not.toThrow();

        expect(bucket.size).toBe(0);
    });

    test('new timers can be scheduled after dispose', () => {
        const bucket = new TimerBucket();
        bucket.schedule(() => {}, 1000);
        bucket.dispose();

        const cb = vi.fn();
        bucket.schedule(cb, 500);
        expect(bucket.size).toBe(1);

        vi.advanceTimersByTime(500);
        expect(cb).toHaveBeenCalledOnce();
    });
});
