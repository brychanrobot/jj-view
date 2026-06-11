/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A queue that runs an async task sequentially, ensuring at most one execution is active at a time.
 * If another run is requested while one is active, it runs exactly one more time after the current
 * run completes. Multiple concurrent requests coalesce to return the promise of that next run.
 */
export class CoalescingQueue {
    private _active: Promise<void> | undefined;
    private _queued: Promise<void> | undefined;

    constructor(private readonly _task: () => Promise<void>) {}

    get currentRun(): Promise<void> | undefined {
        return this._queued || this._active;
    }

    private runTask(): Promise<void> {
        try {
            this._active = this._task().finally(() => {
                this._active = undefined;
            });
            return this._active;
        } catch (err) {
            this._active = Promise.reject(err).finally(() => {
                this._active = undefined;
            });
            return this._active;
        }
    }

    run(): Promise<void> {
        if (this._queued) {
            return this._queued;
        }

        if (this._active) {
            this._queued = this._active
                .catch(() => {})
                .then(() => {
                    this._queued = undefined;
                    return this.runTask();
                });
            return this._queued;
        }

        return this.runTask();
    }
}
