/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ChangeDetectionManager } from './change-detection-manager';
import type { CodeForgeRegistry } from './code-forge-registry';
import { CodeForgeService } from './code-forge-service';
import { AsyncEventEmitter, type Disposable } from './common/events';
import type { JjProcessTracker } from './jj-process-tracker';
import { JjService } from './jj-service';
import type { Uri } from './uri-utils';
import { getJjViewConfig } from './utils/config-utils';
import { DebouncingQueue } from './utils/debouncing-queue';
import type { LoggerChannel } from './utils/output-channel';

interface RefreshPayload {
    forceSnapshot: boolean;
    reasons: Set<string>;
}

export class JjRepository implements Disposable {
    private readonly _jj: JjService;
    private readonly _watcher: ChangeDetectionManager;
    private readonly _codeForge: CodeForgeService;
    private readonly _onDidStatusChange = new AsyncEventEmitter<{ reason: string }>();
    private readonly _refreshQueue: DebouncingQueue<RefreshPayload>;

    readonly onDidStatusChange = this._onDidStatusChange.event;

    constructor(
        public readonly rootUri: Uri,
        public readonly storePath: string,
        registry: CodeForgeRegistry,
        outputChannel: LoggerChannel,
        binaryPath?: string,
        processTracker?: JjProcessTracker,
    ) {
        this._jj = new JjService(rootUri.fsPath, outputChannel, {
            binaryPath,
            getConfig: getJjViewConfig,
            processTracker,
        });
        this._codeForge = new CodeForgeService(rootUri.fsPath, this._jj, registry, outputChannel);

        this._refreshQueue = new DebouncingQueue<RefreshPayload>(
            async (options) => {
                const reason = Array.from(options?.reasons ?? []).join(', ') || 'unknown';

                this._isValid = undefined;
                try {
                    await this._jj.clearCache();
                    if (options?.forceSnapshot) {
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
            },
            {
                getDebounceMillis: () => getJjViewConfig<number>('refreshDebounceMillis', 100) ?? 100,
                getMaxMultiplier: () => getJjViewConfig<number>('refreshDebounceMaxMultiplier', 4) ?? 4,
                mergePayloads: (prev, next) => ({
                    forceSnapshot: prev.forceSnapshot || next.forceSnapshot,
                    reasons: new Set([...prev.reasons, ...next.reasons]),
                }),
                logger: outputChannel,
            },
        );

        this._watcher = new ChangeDetectionManager(rootUri.fsPath, this._jj, outputChannel, async (options) => {
            const payload: RefreshPayload = {
                forceSnapshot: !!options?.forceSnapshot,
                reasons: options?.reason ? new Set([options.reason]) : new Set(),
            };
            try {
                await this._refreshQueue.push(payload);
            } catch {
                // Background change detection refreshes log errors via the queue logger.
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
        const payload: RefreshPayload = {
            forceSnapshot: !!options.forceSnapshot,
            reasons: options.reason ? new Set([options.reason]) : new Set(),
        };
        this._refreshQueue.push(payload);
        return this._refreshQueue.flush();
    }

    async awaitWatchersReady(): Promise<void> {
        await this._watcher.awaitWatchersReady();
    }

    async dispose(): Promise<void> {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._onDidStatusChange.dispose();
        this._codeForge.dispose();
        await this._watcher.dispose();

        const activeRun = this._refreshQueue.currentRun;
        this._refreshQueue.dispose();
        if (activeRun) {
            try {
                await activeRun;
            } catch {
                // Ignore any error during dispose
            }
        }
    }
}
