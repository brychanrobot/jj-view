/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';

/**
 * Manages a polling loop with a strict gap between executions.
 * Ensures only one poll is running at a time and handles disposal.
 */
export class Poller implements vscode.Disposable {
    private _timer: NodeJS.Timeout | undefined;
    private _disposed = false;
    private _isPolling = false;

    constructor(
        private readonly intervalMs: number,
        private readonly callback: () => Promise<void>
    ) {}

    /**
     * Starts the polling loop.
     * @param immediate If true, triggers an execution immediately (with a micro-delay to clear stack).
     */
    start(immediate = false): void {
        if (this._disposed || this._isPolling) {
            return;
        }
        this._isPolling = true;

        if (immediate) {
            // Use a very short delay to allow current call stack to clear
            this._timer = setTimeout(() => this.execute(), 10);
        } else {
            this.schedule();
        }
    }

    /**
     * Stops the polling loop.
     */
    stop(): void {
        this._isPolling = false;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = undefined;
        }
    }

    /**
     * Forces an immediate poll, restarting the timer afterwards if polling is active.
     */
    force(): void {
        if (this._disposed) {
            return;
        }
        
        // Stop current timer
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = undefined;
        }

        // Execute immediately
        // If we want this to be async we should return a promise, but for now fire-and-forget
        // to match start() behavior.
        this.execute();
    }

    private schedule(): void {
        if (this._disposed || !this._isPolling || this._timer) {
            return;
        }
        this._timer = setTimeout(() => this.execute(), this.intervalMs);
    }

    private async execute(): Promise<void> {
        this._timer = undefined;

        if (this._disposed) {
            return;
        }

        try {
            await this.callback();
        } catch (err) {
            // Error handling if needed, or swallow
        }

        // Schedule next run only if still polling and not disposed
        if (!this._disposed && this._isPolling) {
            this.schedule();
        }
    }

    dispose(): void {
        this._disposed = true;
        this.stop();
    }
}
