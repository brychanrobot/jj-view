/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { subscribe, AsyncSubscription, Event, BackendType } from '@parcel/watcher';

export type DirectoryWatcherCallback = (events: Event[]) => void;

export class DirectoryWatcher implements vscode.Disposable {
    private _subscription: AsyncSubscription | undefined;
    private _startPromise: Promise<void> | undefined;
    private _disposed = false;

    constructor(
        private readonly path: string,
        private readonly callback: DirectoryWatcherCallback,
        private readonly outputChannel: vscode.OutputChannel,
        private readonly name: string = 'DirectoryWatcher',
        private readonly backend?: BackendType
    ) {}

    async start(ignores: string[] = []) {
        if (this._startPromise) {
            return this._startPromise;
        }

        this._startPromise = (async () => {
            if (this._subscription || this._disposed) {
                return;
            }

            try {
                this.log(`[${this.name}] Starting watcher on: ${this.path}`);
                
                const sub = await subscribe(
                    this.path,
                    (err, events) => {
                        if (err) {
                            this.log(`[${this.name}] Error: ${err}`);
                            return;
                        }
                        if (events.length > 0) {
                            this.log(`[${this.name}] Event received: ${JSON.stringify(events)}`);
                            this.callback(events);
                        }
                    },
                    { ignore: ignores, backend: this.backend }
                );

                if (this._disposed) {
                    await sub.unsubscribe();
                    return;
                }

                this._subscription = sub;
                this.log(`[${this.name}] Started.`);
            } catch (err) {
                this.log(`[${this.name}] Failed to start: ${err}`);
                const errorMessage = err instanceof Error ? err.message : String(err);
                if (
                    errorMessage.includes('inotify_add_watch') || 
                    errorMessage.includes('ENOSPC') || 
                    errorMessage.includes('No space left on device')
                ) {
                    vscode.window.showWarningMessage(
                        `Failed to start file watcher: inotify watch limit reached. See README for instructions.`,
                        'Open README'
                    ).then(selection => {
                        if (selection === 'Open README') {
                            vscode.env.openExternal(vscode.Uri.parse('https://github.com/brychanrobot/jj-view#file-watcher-mode'));
                        }
                    });
                }
                throw err;
            }
        })();

        return this._startPromise;
    }

    async stop() {
        if (this._startPromise) {
            await this._startPromise.catch(() => {});
            this._startPromise = undefined;
        }

        if (this._subscription) {
            try {
                await this._subscription.unsubscribe();
            } catch (err) {
                this.log(`[${this.name}] Failed to unsubscribe: ${err}`);
            }
            this._subscription = undefined;
        }
    }

    async dispose() {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        await this.stop();
    }

    private log(message: string) {
        if (this._disposed) {
            return;
        }
        try {
            this.outputChannel.appendLine(message);
        } catch {
            // Ignore errors if channel is closed/disposed
        }
    }

}
