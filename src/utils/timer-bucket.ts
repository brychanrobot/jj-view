/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracks a set of `setTimeout` handles so that all pending timers can be
 * cancelled at once via {@link TimerBucket.dispose}.
 *
 * Typical usage:
 * ```ts
 * const bucket = new TimerBucket();
 * bucket.schedule(() => doWork(), 2000);
 * bucket.schedule(() => doWork(), 5000);
 * // Later, to cancel every pending timer:
 * bucket.dispose();
 * ```
 */
export class TimerBucket {
    private handles = new Set<ReturnType<typeof setTimeout>>();

    /**
     * Schedules `callback` to run after `delay` ms and tracks the handle.
     * The handle is automatically removed from the bucket when the timer fires.
     */
    public schedule(callback: () => void, delay: number): void {
        const handle = setTimeout(() => {
            this.handles.delete(handle);
            callback();
        }, delay);
        this.handles.add(handle);
    }

    /** Cancels all pending timers registered with this bucket. */
    public dispose(): void {
        for (const handle of this.handles) {
            clearTimeout(handle);
        }
        this.handles.clear();
    }

    /** Number of timers currently pending (useful for testing). */
    public get size(): number {
        return this.handles.size;
    }
}
