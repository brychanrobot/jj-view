/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight main-thread instrumentation for diff rendering.
 *
 * Splits a render into named synchronous phases (diff/DOM construction,
 * editor attach, ...) and then measures the asynchronous tail the browser
 * still has to do before pixels appear (style, layout, paint) using a
 * double requestAnimationFrame. Any Long Tasks (>50ms main-thread blocks)
 * observed between the start of the render and first paint are attributed
 * to the trace so stalls caused by rendering are visible next to RPC
 * timings in the console.
 */

interface LongTaskRecord {
    startTime: number;
    duration: number;
}

const longTasks: LongTaskRecord[] = [];
let observerStarted = false;

function ensureLongTaskObserver(): void {
    if (observerStarted || typeof PerformanceObserver === 'undefined') {
        return;
    }
    observerStarted = true;
    try {
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                longTasks.push({ startTime: entry.startTime, duration: entry.duration });
            }
            // Keep a bounded window; traces only look back a few seconds.
            if (longTasks.length > 200) {
                longTasks.splice(0, longTasks.length - 200);
            }
        });
        observer.observe({ type: 'longtask', buffered: true });
    } catch {
        // 'longtask' is not supported in every engine (e.g. headless test runners).
    }
}

function longTasksBetween(start: number, end: number): LongTaskRecord[] {
    return longTasks.filter((t) => t.startTime + t.duration >= start && t.startTime <= end);
}

export interface RenderTrace {
    /** Marks the end of a synchronous phase that started at the previous mark. */
    phase(name: string): void;
    /** Schedules the paint measurement and logs the summary once the frame is painted. */
    finish(details: string): void;
}

function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Starts a render trace. Returns a no-op trace when not running in a browser.
 */
export function startRenderTrace(label: string): RenderTrace {
    if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') {
        return { phase: () => {}, finish: () => {} };
    }
    ensureLongTaskObserver();

    const start = now();
    let last = start;
    const phases: string[] = [];

    return {
        phase(name: string): void {
            const t = now();
            phases.push(`${name}: ${(t - last).toFixed(1)}ms`);
            last = t;
        },
        finish(details: string): void {
            const syncEnd = now();
            // First rAF fires before the next frame's style/layout/paint; the second
            // fires after that frame has been committed, so the gap approximates
            // the browser work needed to get the new DOM on screen.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const painted = now();
                    const stalls = longTasksBetween(start, painted);
                    const stallText =
                        stalls.length === 0
                            ? 'none'
                            : stalls
                                  .map((t) => `${t.duration.toFixed(0)}ms@+${(t.startTime - start).toFixed(0)}`)
                                  .join(', ');
                    console.log(
                        `[Perf:Pierre] paint(${label}) sync=${(syncEnd - start).toFixed(1)}ms [${phases.join(', ')}] ` +
                            `layout+paint=${(painted - syncEnd).toFixed(1)}ms total=${(painted - start).toFixed(1)}ms ` +
                            `longtasks=${stallText} ${details}`,
                    );
                });
            });
        },
    };
}
