/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Disposable, Uri } from 'vscode';
import { ChangeDetectionManager } from './change-detection-manager';
import type { CodeForgeRegistry } from './code-forge-registry';
import { CodeForgeService } from './code-forge-service';
import { JjService } from './jj-service';
import { RefreshScheduler } from './refresh-scheduler';
import { AsyncEventEmitter } from './utils/async-event-emitter';
import { CoalescingQueue } from './utils/coalescing-queue';
import type { JjLoggerChannel } from './utils/output-channel';

export class JjRepository implements Disposable {
    private readonly _jj: JjService;
    private readonly _watcher: ChangeDetectionManager;
    private readonly _codeForge: CodeForgeService;
    private readonly _refreshScheduler: RefreshScheduler;
    private readonly _onDidStatusChange = new AsyncEventEmitter<{ reason: string }>();
    private _nextRefreshOptions = { forceSnapshot: false, reasons: new Set<string>() };
    private readonly _refreshQueue: CoalescingQueue;

    readonly onDidStatusChange = this._onDidStatusChange.event;

    constructor(
        public readonly rootUri: Uri,
        public readonly storePath: string,
        registry: CodeForgeRegistry,
        outputChannel: JjLoggerChannel,
        binaryPath?: string,
    ) {
        this._jj = new JjService(
            rootUri.fsPath,
            {
                info: (msg) => {
                    try {
                        outputChannel.info(msg);
                    } catch {}
                },
                warn: (msg) => {
                    try {
                        outputChannel.warn(msg);
                    } catch {}
                },
                error: (msg) => {
                    try {
                        outputChannel.error(msg);
                    } catch {}
                },
                debug: (msg) => {
                    try {
                        outputChannel.debug(msg);
                    } catch {}
                },
            },
            binaryPath,
        );
        this._codeForge = new CodeForgeService(rootUri.fsPath, this._jj, registry, outputChannel);
        this._refreshScheduler = new RefreshScheduler((options) => this.refresh(options));
        this._watcher = new ChangeDetectionManager(rootUri.fsPath, this._jj, outputChannel, async (options) => {
            await this._refreshScheduler.trigger(options);
        });

        this._refreshQueue = new CoalescingQueue(async () => {
            const options = { ...this._nextRefreshOptions };
            this._nextRefreshOptions = { forceSnapshot: false, reasons: new Set<string>() };

            const reason = Array.from(options.reasons).join(', ') || 'manual';

            this._isValid = undefined;
            try {
                await this._jj.clearCache();
                if (options.forceSnapshot) {
                    await this._jj.status();
                }
                await this._jj.getRepoRoot(); // Warm the cache

                if (!this._disposed) {
                    await this._onDidStatusChange.fire({ reason });
                }
            } catch (err) {
                if (!this._disposed) {
                    throw err;
                }
            }
        });
    }

    get activeRefresh(): Promise<void> | undefined {
        return this._refreshQueue.currentRun;
    }

    get jj(): JjService {
        return this._jj;
    }

    get codeForge(): CodeForgeService {
        return this._codeForge;
    }

    get watcher(): ChangeDetectionManager {
        return this._watcher;
    }

    private _disposed = false;
    private _isValid: boolean | undefined;
    async isValid(): Promise<boolean> {
        if (this._isValid !== undefined) {
            return this._isValid;
        }
        try {
            await fs.access(path.join(this.rootUri.fsPath, '.jj', 'working_copy', 'type'));
            this._isValid = true;
        } catch {
            this._isValid = false;
        }
        return this._isValid;
    }

    async refresh(options: { forceSnapshot?: boolean; reason?: string } = {}): Promise<void> {
        if (this._disposed) {
            return;
        }
        if (options.forceSnapshot) {
            this._nextRefreshOptions.forceSnapshot = true;
        }
        if (options.reason) {
            this._nextRefreshOptions.reasons.add(options.reason);
        }
        return this._refreshQueue.run();
    }

    async awaitWatchersReady(): Promise<void> {
        await this._watcher.awaitWatchersReady();
    }

    async dispose() {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._codeForge.dispose();
        await this._watcher.dispose();
        this._refreshScheduler.dispose();

        // Wait for any active background refreshes to complete
        if (this._refreshQueue.currentRun) {
            try {
                await this._refreshQueue.currentRun;
            } catch {
                // Ignore any error during dispose
            }
        }
    }
}
