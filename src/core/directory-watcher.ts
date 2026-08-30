/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type AsyncSubscription, type BackendType, type Event, subscribe } from '@parcel/watcher';
import { isWatchmanAvailable } from '../utils/binary-utils';
import { toError } from '../utils/error-utils';
import type { LoggerChannel } from '../utils/output-channel';
import type { HostDisposable, HostEnvironment } from './host/host-environment';
import { Uri } from './uri-utils';

export type DirectoryWatcherCallback = (events: Event[]) => void;

export class DirectoryWatcher implements HostDisposable {
    private _subscription: AsyncSubscription | undefined;
    private _startPromise: Promise<void> | undefined;
    private _disposed = false;
    private _stopped = false;
    private _backend: Promise<BackendType | undefined>;

    constructor(
        private readonly path: string,
        private readonly callback: DirectoryWatcherCallback,
        private readonly outputChannel: LoggerChannel,
        private readonly name: string = 'DirectoryWatcher',
        backend?: BackendType,
        private readonly host?: HostEnvironment,
    ) {
        this._backend = (async () => {
            if (backend) {
                return backend;
            } else if (await isWatchmanAvailable()) {
                return 'watchman';
            } else if (process.platform === 'win32') {
                return 'windows';
            } else if (process.platform === 'linux') {
                return 'inotify';
            } else if (process.platform === 'darwin') {
                return 'fs-events';
            } else {
                return undefined;
            }
        })();
    }

    async start(ignores: string[] = []): Promise<void> {
        this._stopped = false;
        if (this._startPromise) {
            return this._startPromise;
        }

        this._startPromise = this.startInternal(ignores);
        return this._startPromise;
    }

    private async startInternal(ignores: string[]): Promise<void> {
        if (this._subscription || this._disposed || this._stopped) {
            return;
        }

        try {
            const backend = await this._backend;
            if (this._disposed || this._stopped) {
                return;
            }
            this.log(`[${this.name}] Starting (${backend}) watcher on: ${this.path}`);

            const sub = await subscribe(
                this.path,
                (err, events) => {
                    if (err) {
                        this.logError(`[${this.name}] Error`, err);
                        return;
                    }
                    if (events.length > 0) {
                        this.log(`[${this.name}] Event received: ${JSON.stringify(events)}`);
                        this.callback(events);
                    }
                },
                { ignore: ignores, backend },
            );

            if (this._disposed || this._stopped) {
                await sub.unsubscribe();
                return;
            }

            this._subscription = sub;
            this.log(`[${this.name}] Started.`);
        } catch (err) {
            this._startPromise = undefined;
            this.logError(`[${this.name}] Failed to start`, err);
            this.handleInotifyError(err);
            throw err;
        }
    }

    private handleInotifyError(err: unknown): void {
        if (!this.host) {
            return;
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isInotifyLimit =
            errorMessage.includes('inotify_add_watch') ||
            errorMessage.includes('ENOSPC') ||
            errorMessage.includes('No space left on device');
        if (!isInotifyLimit) {
            return;
        }

        void this.host.ui
            .showWarning(
                'Failed to start file watcher: inotify watch limit reached. See README for instructions.',
                'Open README',
            )
            .then((selection) => {
                if (selection === 'Open README') {
                    void this.host?.nav
                        .openExternal(Uri.parse('https://github.com/brychanrobot/jj-view#file-watcher-mode'))
                        .catch(() => {});
                }
            })
            .catch(() => {});
    }

    async stop() {
        this._stopped = true;
        if (this._startPromise) {
            await this._startPromise.catch(() => {});
            this._startPromise = undefined;
        }

        if (this._subscription) {
            try {
                await this._subscription.unsubscribe();
            } catch (err) {
                this.logError(`[${this.name}] Failed to unsubscribe`, err);
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
            this.outputChannel.info(message);
        } catch {
            // Ignore errors if channel is closed/disposed
        }
    }

    private logError(message: string, err?: unknown) {
        if (this._disposed) {
            return;
        }
        try {
            this.outputChannel.error(message, err !== undefined ? toError(err) : undefined);
        } catch {
            // Ignore errors if channel is closed/disposed
        }
    }
}
