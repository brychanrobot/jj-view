// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as vscode from 'vscode';

export class RefreshScheduler implements vscode.Disposable {
    private _debounceTimer: NodeJS.Timeout | undefined;
    private _baseDebounce: number;
    private _maxMultiplier: number;
    private _multiplier: number = 1;
    private _hasNewEvents: boolean = false;
    private _disposed: boolean = false;

    constructor(private refreshCallback: () => void | Promise<void>) {
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

    public trigger() {
        if (this._disposed) {
            return;
        }

        this._hasNewEvents = true;

        // If loop is already running (timer exists), just marking hasNewEvents is enough.
        // It will be picked up when the current timer fires.
        if (this._debounceTimer) {
            return;
        }

        // Start the loop
        this._scheduleNextRun();
    }

    private _scheduleNextRun() {
        if (this._disposed) {
            return;
        }

        const timeoutMs = this._baseDebounce * this._multiplier;

        this._debounceTimer = setTimeout(async () => {
            this._debounceTimer = undefined;

            if (this._hasNewEvents) {
                this._hasNewEvents = false;
                try {
                    await this.refreshCallback();
                } catch (e) {
                    console.error('Refresh failed in scheduler:', e);
                }

                this._multiplier = Math.min(this._multiplier + 1, this._maxMultiplier);
                this._scheduleNextRun();
            } else {
                this._multiplier = 1;
            }
        }, timeoutMs);
    }

    public dispose() {
        this._disposed = true;
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = undefined;
        }
    }
}
