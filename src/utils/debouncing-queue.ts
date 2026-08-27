/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { toError } from './error-utils';
import type { LoggerChannel } from './output-channel';

export interface IDisposable {
    dispose(): void;
}

export interface DebouncingQueueOptions<TPayload> {
    /** Debounce delay in milliseconds (or dynamic getter, default: 100) */
    getDebounceMillis?: () => number;
    /** Maximum backoff multiplier under continuous events (default: 4) */
    getMaxMultiplier?: () => number;
    /** Custom reducer to merge incoming payloads during debouncing */
    mergePayloads?: (accumulated: TPayload, incoming: TPayload) => TPayload;
    /** Optional logger channel to log task errors */
    logger?: LoggerChannel;
}

interface PendingBatch<TPayload> {
    payload: TPayload | undefined;
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: unknown) => void;
    immediate: boolean;
}

interface ActiveExecution {
    promise: Promise<void>;
    cancelled: boolean;
}

/**
 * A generic, sequential task queue that coalesces bursts of triggers with
 * configurable debouncing and exponential backoff, while supporting instant execution via flush().
 */
export class DebouncingQueue<TPayload = void> implements IDisposable {
    private _activeExecution: ActiveExecution | undefined;
    private _timer: NodeJS.Timeout | undefined;
    private _multiplier = 1;
    private _disposed = false;
    private _pending: PendingBatch<TPayload> | undefined;

    constructor(
        private readonly _task: (payload?: TPayload) => Promise<void>,
        private readonly _options?: DebouncingQueueOptions<TPayload>,
    ) {}

    private get _baseDebounce(): number {
        return this._options?.getDebounceMillis?.() ?? 100;
    }

    private get _maxMultiplier(): number {
        return this._options?.getMaxMultiplier?.() ?? 4;
    }

    public get currentRun(): Promise<void> | undefined {
        return this._pending?.promise || this._activeExecution?.promise;
    }

    /**
     * Enqueue a payload. If idle, schedules debounced execution with backoff.
     */
    public push(payload?: TPayload): Promise<void> {
        if (this._disposed) {
            return Promise.resolve();
        }

        const pending = this._getOrCreatePending(payload);
        if (!this._timer && !this._activeExecution) {
            this._scheduleDebounce();
        }
        return pending.promise;
    }

    /**
     * Parameterless flush: Immediately executes any pending buffered payloads.
     * Cancels any active debounce timer and runs now (or next in line if already in-flight).
     */
    public flush(): Promise<void> {
        if (this._disposed) {
            return Promise.resolve();
        }

        this._clearTimer();

        if (!this._pending) {
            return this._activeExecution?.promise ?? Promise.resolve();
        }

        this._pending.immediate = true;
        const promise = this._pending.promise;

        if (!this._activeExecution) {
            void this._runCycle();
        }
        return promise;
    }

    /**
     * Cancel any pending timer and drop buffered payload without executing.
     */
    public cancel(): void {
        this._multiplier = 1;
        if (this._activeExecution) {
            this._activeExecution.cancelled = true;
        }
        this._clearTimer();
        if (this._pending) {
            this._pending.resolve();
            this._pending = undefined;
        }
    }

    private _getOrCreatePending(incoming?: TPayload): PendingBatch<TPayload> {
        if (this._pending) {
            if (incoming !== undefined) {
                if (this._pending.payload !== undefined && this._options?.mergePayloads) {
                    this._pending.payload = this._options.mergePayloads(this._pending.payload, incoming);
                } else {
                    this._pending.payload = incoming;
                }
            }
            return this._pending;
        }

        let resolve!: () => void;
        let reject!: (err: unknown) => void;
        const promise = new Promise<void>((r, rej) => {
            resolve = r;
            reject = rej;
        });
        this._pending = { payload: incoming, promise, resolve, reject, immediate: false };
        return this._pending;
    }

    private _scheduleDebounce(): void {
        if (this._disposed || this._timer) {
            return;
        }

        const effectiveMultiplier = Math.min(this._multiplier, this._maxMultiplier);
        const delay = this._baseDebounce * effectiveMultiplier;
        this._timer = setTimeout(() => {
            this._timer = undefined;
            void this._runCycle();
        }, delay);
    }

    private async _runCycle(): Promise<void> {
        if (this._disposed || !this._pending) {
            this._multiplier = 1;
            return;
        }

        const batch = this._pending;
        this._pending = undefined;

        this._activeExecution = {
            // Defer task execution to the microtask queue via Promise.resolve().then()
            // so this._activeExecution is synchronously assigned before any code inside _task runs.
            // This protects against synchronous re-entrant calls from spawning concurrent cycles.
            promise: Promise.resolve().then(() => this._task(batch.payload)),
            cancelled: false,
        };

        let taskError: unknown;
        try {
            await this._activeExecution.promise;
        } catch (err) {
            taskError = err;
            if (this._options?.logger) {
                this._options.logger.error('DebouncingQueue task error:', toError(err));
            } else {
                console.error('DebouncingQueue task error:', err);
            }
        } finally {
            const wasCancelled = this._activeExecution?.cancelled;
            this._activeExecution = undefined;
            if (taskError) {
                batch.reject(taskError);
            } else {
                batch.resolve();
            }

            if (this._disposed) {
                this._multiplier = 1;
            } else if (wasCancelled) {
                this._multiplier = 1;
                if (this._queuedBatch) {
                    if (this._queuedBatch.immediate) {
                        void this._runCycle();
                    } else {
                        this._scheduleDebounce();
                    }
                }
            } else if (this._queuedBatch?.immediate) {
                void this._runCycle();
            } else {
                this._multiplier += 1;
                this._scheduleDebounce();
            }
        }
    }

    private get _queuedBatch(): PendingBatch<TPayload> | undefined {
        return this._pending;
    }

    private _clearTimer(): void {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = undefined;
        }
    }

    public dispose(): void {
        this._disposed = true;
        this._multiplier = 1;
        this._clearTimer();
        if (this._pending) {
            this._pending.resolve();
            this._pending = undefined;
        }
    }
}
