/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';

export class RefreshScheduler implements vscode.Disposable {
    private _debounceTimer: NodeJS.Timeout | undefined;
    private _baseDebounce: number;
    private _maxMultiplier: number;
    private _multiplier: number = 1;
    private _hasNewEvents: boolean = false;
    private _disposed: boolean = false;

    private _pendingForceSnapshot: boolean = false;
    private _pendingReasons: Set<string> = new Set();
    
    // Single shared promise for all callers of trigger() in current cycle
    private _pendingPromise: Promise<void> | undefined;
    private _pendingResolve: (() => void) | undefined;

    constructor(private refreshCallback: (options: { forceSnapshot: boolean; reason?: string }) => void | Promise<void>) {
        const config = vscode.workspace.getConfiguration('jj-view');
        this._baseDebounce = config.get<number>('refreshDebounceMillis', 100);
        this._maxMultiplier = config.get<number>('refreshDebounceMaxMultiplier', 4);

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('jj-view')) {
                const newConfig = vscode.workspace.getConfiguration('jj-view');
                this._baseDebounce = newConfig.get<number>('refreshDebounceMillis', 100);
                this._maxMultiplier = newConfig.get<number>('refreshDebounceMaxMultiplier', 4);
            }
        });
    }

    public trigger(options: { forceSnapshot?: boolean; reason?: string } = {}): Promise<void> {
        if (this._disposed) {
            return Promise.resolve();
        }

        this._hasNewEvents = true;
        if (options.forceSnapshot) {
            this._pendingForceSnapshot = true;
        }
        if (options.reason) {
            this._pendingReasons.add(options.reason);
        }

        // Return existing promise if one is already pending
        if (this._pendingPromise) {
            return this._pendingPromise;
        }

        // Create a new shared promise for this refresh cycle
        this._pendingPromise = new Promise<void>((resolve) => {
            this._pendingResolve = resolve;
        });

        // Start the loop if not already running
        if (!this._debounceTimer) {
            this._scheduleNextRun();
        }

        return this._pendingPromise;
    }

    private _scheduleNextRun() {
        if (this._disposed) {
            this._resolvePending();
            return;
        }

        const timeoutMs = this._baseDebounce * this._multiplier;

        this._debounceTimer = setTimeout(async () => {
            this._debounceTimer = undefined;

            if (this._hasNewEvents) {
                this._hasNewEvents = false;
                const forceSnapshot = this._pendingForceSnapshot;
                this._pendingForceSnapshot = false;
                
                const reasons = Array.from(this._pendingReasons).join(', ');
                this._pendingReasons.clear();

                try {
                    await this.refreshCallback({ forceSnapshot, reason: reasons || undefined });
                } catch (e) {
                    console.error('Refresh failed in scheduler:', e);
                }

                // Resolve all waiting promises
                this._resolvePending();

                this._multiplier = Math.min(this._multiplier + 1, this._maxMultiplier);
                this._scheduleNextRun();
            } else {
                this._multiplier = 1;
                this._resolvePending();
            }
        }, timeoutMs);
    }

    private _resolvePending() {
        if (this._pendingResolve) {
            this._pendingResolve();
            this._pendingResolve = undefined;
            this._pendingPromise = undefined;
        }
    }

    public dispose() {
        this._disposed = true;
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = undefined;
        }
    }
}
