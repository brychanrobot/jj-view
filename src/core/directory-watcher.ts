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

export interface ReconnectOptions {
    /** Initial retry delay in milliseconds (default: 1000) */
    initialDelayMs?: number;
    /** Maximum retry delay in milliseconds (default: 30000) */
    maxDelayMs?: number;
    /** Optional maximum retries before permanent failure (default: unlimited) */
    maxRetries?: number;
}

export interface DirectoryWatcherOptions {
    name?: string;
    backend?: BackendType;
    host?: HostEnvironment;
    onReconnect?: () => void | Promise<void>;
    onPermanentFailure?: (err: unknown) => void | Promise<void>;
    reconnectOptions?: ReconnectOptions;
}

export class DirectoryWatcher implements HostDisposable {
    private readonly name: string;
    private readonly host: HostEnvironment | undefined;
    private readonly onReconnect: (() => void | Promise<void>) | undefined;
    private readonly onPermanentFailure: ((err: unknown) => void | Promise<void>) | undefined;
    private readonly _initialReconnectDelay: number;
    private readonly _maxReconnectDelay: number;
    private readonly _maxRetries: number | undefined;

    private _subscription: AsyncSubscription | undefined;
    private _startPromise: Promise<void> | undefined;
    private _stopPromise: Promise<void> | undefined;
    private _reconnectPromise: Promise<void> | undefined;
    private _reconnectTimeout: NodeJS.Timeout | undefined;
    private _isReconnecting = false;
    private _currentReconnectDelay: number;
    private _retryCount = 0;
    private _disposed = false;
    private _stopped = false;
    private _backend: Promise<BackendType | undefined>;
    private _lastIgnores: string[] = [];

    constructor(
        private readonly path: string,
        private readonly callback: DirectoryWatcherCallback,
        private readonly outputChannel: LoggerChannel,
        options?: DirectoryWatcherOptions,
    ) {
        this.name = options?.name ?? 'DirectoryWatcher';
        this.host = options?.host;
        this.onReconnect = options?.onReconnect;
        this.onPermanentFailure = options?.onPermanentFailure;
        this._initialReconnectDelay = Math.max(1, options?.reconnectOptions?.initialDelayMs ?? 1000);
        this._maxReconnectDelay = Math.max(this._initialReconnectDelay, options?.reconnectOptions?.maxDelayMs ?? 30000);
        this._maxRetries = options?.reconnectOptions?.maxRetries;
        this._currentReconnectDelay = this._initialReconnectDelay;

        this._backend = (async () => {
            if (options?.backend) {
                return options.backend;
            }
            if (await isWatchmanAvailable()) {
                return 'watchman';
            }
            if (process.platform === 'win32') {
                return 'windows';
            }
            if (process.platform === 'linux') {
                return 'inotify';
            }
            if (process.platform === 'darwin') {
                return 'fs-events';
            }
            return undefined;
        })();
    }

    async start(ignores: string[] = []): Promise<void> {
        this._lastIgnores = ignores;
        this._stopped = false;
        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
            this._reconnectTimeout = undefined;
        }
        if (this._startPromise) {
            return this._startPromise;
        }

        this._startPromise = this.startInternal(ignores).finally(() => {
            this._startPromise = undefined;
        });
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
                        this.handleSubscriptionError(err);
                        return;
                    }
                    if (this._disposed || this._stopped) {
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
                try {
                    await sub.unsubscribe();
                } catch (err) {
                    this.logError(`[${this.name}] Failed to unsubscribe`, err);
                }
                return;
            }

            this._subscription = sub;
            this._currentReconnectDelay = this._initialReconnectDelay;
            this._retryCount = 0;
            this.log(`[${this.name}] Started.`);
        } catch (err) {
            this.logError(`[${this.name}] Failed to start`, err);
            this.handleInotifyError(err);
            throw err;
        }
    }

    private isInotifyLimitError(err: unknown): boolean {
        const errObj = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : undefined;
        if (typeof errObj?.code === 'string' && errObj.code === 'ENOSPC') {
            return true;
        }
        const errorMessage =
            typeof errObj?.message === 'string' ? errObj.message : err instanceof Error ? err.message : String(err);
        const lower = errorMessage.toLowerCase();
        return (
            errorMessage.includes('inotify_add_watch') ||
            errorMessage.includes('ENOSPC') ||
            lower.includes('no space left on device') ||
            lower.includes('max_user_watches') ||
            lower.includes('inotify watch limit') ||
            lower.includes('inotify limit')
        );
    }

    private handleInotifyError(err: unknown): void {
        if (!this.host || !this.isInotifyLimitError(err)) {
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

    private notifyPermanentFailure(err: unknown): void {
        this._stopped = true;
        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
            this._reconnectTimeout = undefined;
        }
        try {
            const result = this.onPermanentFailure?.(err);
            if (result instanceof Promise) {
                result.catch((cbErr: unknown) => {
                    this.logError(`[${this.name}] Error in onPermanentFailure callback`, cbErr);
                });
            }
        } catch (cbErr) {
            this.logError(`[${this.name}] Error in onPermanentFailure callback`, cbErr);
        }
    }

    private handleSubscriptionError(err: unknown): void {
        if (this._disposed || this._stopped) {
            return;
        }

        const deadSub = this._subscription;
        this._subscription = undefined;
        if (deadSub) {
            try {
                deadSub.unsubscribe().catch((unsubErr) => {
                    this.logError(`[${this.name}] Failed to unsubscribe dead subscription`, unsubErr);
                });
            } catch (unsubErr) {
                this.logError(`[${this.name}] Failed to unsubscribe dead subscription`, unsubErr);
            }
        }

        if (this.isInotifyLimitError(err)) {
            this.handleInotifyError(err);
            this.notifyPermanentFailure(err);
            return;
        }

        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this._disposed || this._stopped || this._reconnectTimeout !== undefined || this._isReconnecting) {
            return;
        }

        if (this._maxRetries !== undefined && this._retryCount >= this._maxRetries) {
            const maxRetriesError = new Error(
                `[${this.name}] Maximum reconnection attempts (${this._maxRetries}) exceeded`,
            );
            this.logError(maxRetriesError.message, maxRetriesError);
            this.notifyPermanentFailure(maxRetriesError);
            return;
        }

        const delay = this._currentReconnectDelay;
        const attempt = this._retryCount + 1;
        this.log(`[${this.name}] Scheduling reconnect in ${delay}ms (attempt ${attempt})`);

        this._reconnectTimeout = setTimeout(() => {
            this._reconnectTimeout = undefined;
            this._reconnectPromise = this.attemptReconnect()
                .catch((err) => {
                    this.logError(`[${this.name}] Unexpected error during reconnection attempt`, err);
                })
                .finally(() => {
                    this._reconnectPromise = undefined;
                });
        }, delay);

        this._currentReconnectDelay = Math.min(this._currentReconnectDelay * 2, this._maxReconnectDelay);
        this._retryCount++;
    }

    private async attemptReconnect(): Promise<void> {
        if (this._disposed || this._stopped) {
            return;
        }

        this._isReconnecting = true;
        this.log(`[${this.name}] Attempting reconnect...`);

        try {
            if (this._startPromise) {
                await this._startPromise;
            } else {
                this._startPromise = this.startInternal(this._lastIgnores).finally(() => {
                    this._startPromise = undefined;
                });
                await this._startPromise;
            }
        } catch (err) {
            this._isReconnecting = false;
            if (this._disposed || this._stopped) {
                return;
            }
            this.logError(`[${this.name}] Reconnection attempt failed`, err);
            if (this.isInotifyLimitError(err)) {
                this.notifyPermanentFailure(err);
                return;
            }
            this.scheduleReconnect();
            return;
        }

        this._isReconnecting = false;
        if (this._disposed || this._stopped) {
            return;
        }

        this.log(`[${this.name}] Reconnected successfully.`);
        this._currentReconnectDelay = this._initialReconnectDelay;
        this._retryCount = 0;

        try {
            await this.onReconnect?.();
        } catch (err) {
            this.logError(`[${this.name}] Error in onReconnect callback`, err);
        }
    }

    async stop(): Promise<void> {
        if (this._stopPromise) {
            return this._stopPromise;
        }
        this._stopPromise = this.stopInternal().finally(() => {
            this._stopPromise = undefined;
        });
        return this._stopPromise;
    }

    private async stopInternal(): Promise<void> {
        this._stopped = true;
        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
            this._reconnectTimeout = undefined;
        }
        this._isReconnecting = false;
        this._retryCount = 0;
        this._currentReconnectDelay = this._initialReconnectDelay;

        if (this._reconnectPromise) {
            await this._reconnectPromise.catch(() => {});
            this._reconnectPromise = undefined;
        }

        if (this._startPromise) {
            await this._startPromise.catch(() => {});
            this._startPromise = undefined;
        }

        const sub = this._subscription;
        this._subscription = undefined;

        if (sub) {
            try {
                await sub.unsubscribe();
            } catch (err) {
                this.logError(`[${this.name}] Failed to unsubscribe`, err);
            }
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
