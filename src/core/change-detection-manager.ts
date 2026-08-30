/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BackendType } from '@parcel/watcher';
import type { LoggerChannel } from '../utils/output-channel';
import { DirectoryWatcher } from './directory-watcher';
import type { HostDisposable, HostEnvironment } from './host/host-environment';
import type { JjService } from './jj-service';
import { Poller } from './poller';

export class ChangeDetectionManager implements HostDisposable {
    private _disposed = false;
    private disposables: HostDisposable[] = [];

    private _workingCopyWatcher: DirectoryWatcher | undefined;
    private _opHeadsWatcher: DirectoryWatcher | undefined;
    private _lifecyclePromise: Promise<void> = Promise.resolve();
    private _poller: Poller;
    private _fileWatcherMode: 'polling' | 'watch' = 'polling';
    private _isFocused = true;
    private lastExternalOpTime = 0;
    private _deferredRefreshTimeout: NodeJS.Timeout | undefined;
    private _watchersWarmedUp = false;

    private async _runLifecycleTask(task: () => Promise<void>): Promise<void> {
        this._lifecyclePromise = this._lifecyclePromise
            .catch(() => {})
            .then(async () => {
                await task();
            });
        return this._lifecyclePromise;
    }

    private get hasActiveOrRecentWrites(): boolean {
        return (
            this.jj.hasActiveWriteOps ||
            Date.now() - this.jj.lastWriteTime < 500 ||
            Date.now() - this.lastExternalOpTime < 500
        );
    }

    private _scheduleDeferredRefresh() {
        if (this._deferredRefreshTimeout) {
            return;
        }
        this._deferredRefreshTimeout = setTimeout(() => {
            this._deferredRefreshTimeout = undefined;
            if (this._disposed) {
                return;
            }
            const writes = this.hasActiveOrRecentWrites;
            if (writes) {
                this._scheduleDeferredRefresh();
            } else {
                this.lastExternalOpTime = Date.now();
                this.triggerRefresh({ forceSnapshot: false, reason: 'deferred watcher event' });
            }
        }, 500);
    }

    constructor(
        private workspaceRoot: string,
        private jj: JjService,
        private outputChannel: LoggerChannel,
        private triggerRefresh: (event: { forceSnapshot: boolean; reason: string }) => Promise<void>,
        private readonly host: HostEnvironment,
        private readonly watcherBackend?: BackendType,
    ) {
        // Initialize poller with 5 second interval
        this._poller = new Poller(5000, async () => {
            // Skip if a write operation is in progress or just finished
            if (!this.hasActiveOrRecentWrites) {
                await this.triggerRefresh({ forceSnapshot: true, reason: 'poll' });
            }
        });

        // 1. Watch for editor saves (catches user edits in host)
        if (this.host.documents.onDidSaveDocument) {
            this.disposables.push(
                this.host.documents.onDidSaveDocument((uri) => {
                    if (this._disposed) {
                        return;
                    }
                    if (uri.scheme !== 'file') {
                        return;
                    }
                    const { fsPath } = uri;
                    if (/[\\/]\.jj[\\/]/.test(fsPath)) {
                        return;
                    }
                    const relative = path.relative(this.workspaceRoot, fsPath);
                    if (relative.startsWith('..') || path.isAbsolute(relative)) {
                        return;
                    }
                    this.triggerRefresh({ forceSnapshot: true, reason: 'file saved' });
                }),
            );
        }

        // 2. Poll for external changes or start main watcher
        // Listen for window state changes to pause/resume polling if in polling mode
        this._isFocused = this.host.ui.isFocused ?? true;
        if (this.host.ui.onDidChangeFocus) {
            this.disposables.push(
                this.host.ui.onDidChangeFocus((focused) => {
                    this.onWindowStateChange(focused);
                }),
            );
        }

        // Listen for configuration changes
        if (this.host.config.onDidChangeConfiguration) {
            this.disposables.push(
                this.host.config.onDidChangeConfiguration(async (e) => {
                    if (e.affectsConfiguration('jj-view.fileWatcherMode')) {
                        await this.updateFileWatcherMode();
                    }
                }),
            );
        }

        // Initialize watchers synchronously
        this._lifecyclePromise = Promise.all([this.startOpHeadsWatcher(), this.updateFileWatcherModeInternal()])
            .then(() => {})
            .catch((err) => {
                this.outputChannel.error(`[ChangeDetectionManager] Error during initialization: ${err}`);
            });
    }

    public async awaitWatchersReady(): Promise<void> {
        await this._lifecyclePromise.catch(() => {});
        if (this._fileWatcherMode === 'watch' && !this._watchersWarmedUp) {
            // Give the OS/file system a brief moment to fully register and warm up the new watches
            await new Promise((resolve) => setTimeout(resolve, 50));
            this._watchersWarmedUp = true;
        }
    }

    private async updateFileWatcherMode() {
        return this._runLifecycleTask(async () => {
            await this.updateFileWatcherModeInternal();
        });
    }

    private async updateFileWatcherModeInternal() {
        if (this._disposed) {
            return;
        }
        const mode = this.host.config.get<'polling' | 'watch'>('fileWatcherMode', 'polling') ?? 'polling';
        this.outputChannel.debug(`[ChangeDetectionManager] File watcher mode: ${mode}`);

        const modeChanged = this._fileWatcherMode !== mode;
        this._fileWatcherMode = mode;

        if (modeChanged) {
            await this.stopWorkingCopyWatchingInternal();
            await this.startWorkingCopyWatchingInternal();
        }

        // Always ensure polling state is correct
        this.updatePollingState();
    }

    private onWindowStateChange(focused: boolean) {
        this._isFocused = focused;
        // If getting focused, we want an immediate poll
        this.updatePollingState(focused);
    }

    /**
     * Reconciles the polling state based on current mode, focus, and disposal status.
     * Starts or stops the poller accordingly.
     *
     * @param immediate If true, attempts to force an immediate poll execution if polling is active.
     */
    private updatePollingState(immediate = false) {
        // If not in polling mode, or not focused, or disposed -> Stop
        if (this._fileWatcherMode !== 'polling' || !this._isFocused || this._disposed) {
            this._poller.stop();
            return;
        }

        // We are in polling mode and focused.
        this._poller.start();

        if (immediate) {
            // Force an immediate poll to ensure responsiveness
            this._poller.force();
        }
    }

    private async startOpHeadsWatcher() {
        if (this._disposed) {
            return;
        }
        if (this._opHeadsWatcher) {
            return;
        }

        let retries = 0;
        const maxRetries = 25; // 5 seconds total (25 * 200ms)
        let lastErr: unknown;

        while (retries < maxRetries && !this._disposed) {
            try {
                await this.jj.getRepoRoot();

                // Handle non-default workspaces where .jj/repo might be a file containing a path
                const repoStorePath = await this.jj.getRepoStorePath();
                if (this._disposed) {
                    return;
                }

                const opHeadsPath = path.join(repoStorePath, 'op_heads');

                // Final check that the directory exists and we have a real path
                const realOpHeadsPath = await fs.realpath(opHeadsPath);

                if (this._disposed) {
                    return;
                }

                this._opHeadsWatcher = new DirectoryWatcher(
                    realOpHeadsPath,
                    () => {
                        const writes = this.hasActiveOrRecentWrites;
                        if (writes) {
                            this._scheduleDeferredRefresh();
                            return;
                        }
                        this.lastExternalOpTime = Date.now();
                        this.triggerRefresh({ forceSnapshot: false, reason: 'jj operation' });
                    },
                    this.outputChannel,
                    'OpHeads Watcher',
                    this.watcherBackend,
                    this.host,
                );
                await this._opHeadsWatcher.start();
                return; // Success
            } catch (err) {
                if (this._disposed) {
                    return;
                }
                this.outputChannel.error(
                    `[Error] [ChangeDetectionManager] startOpHeadsWatcher retry ${retries} failed for path ${this.workspaceRoot}: ${err instanceof Error ? err.stack : err}`,
                );
                lastErr = err;
                retries++;
                if (retries < maxRetries && !this._disposed) {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
            }
        }

        if (!this._disposed) {
            this.outputChannel.error(`Failed to setup op_heads watcher after ${maxRetries} retries: ${lastErr}`);
        }
    }

    private async startWorkingCopyWatchingInternal() {
        if (this._disposed) {
            return;
        }
        if (this._fileWatcherMode === 'watch') {
            await this.startWorkingCopyWatcherInternal().catch((err) => {
                this.outputChannel.error(`Failed to start working copy watcher: ${err}`);
                this.outputChannel.info('Falling back to polling mode.');
                this._fileWatcherMode = 'polling';
                this.updatePollingState();
            });
        } else {
            this.updatePollingState();
        }
    }

    private async stopWorkingCopyWatchingInternal() {
        // Also stop polling if it was active
        this._poller.stop();

        if (this._workingCopyWatcher) {
            await this._workingCopyWatcher.stop();
            this._workingCopyWatcher = undefined;
        }
    }

    private async startWorkingCopyWatcherInternal() {
        if (this._disposed) {
            return;
        }
        if (this._workingCopyWatcher) {
            return;
        }

        const [gitIgnores, gitModules, workspaceRoots] = await Promise.all([
            this.getGitIgnorePatterns(),
            this.getGitModulesPatterns(),
            this.getSecondaryWorkspacePatterns(),
        ]);
        if (this._disposed || this._fileWatcherMode !== 'watch') {
            return;
        }

        const ignore = ['.git', '.jj', '.vscode-test', 'node_modules', ...gitIgnores, ...gitModules, ...workspaceRoots];
        this.outputChannel.debug(`[ChangeDetectionManager] Watcher ignore list: ${JSON.stringify(ignore)}`);

        this._workingCopyWatcher = new DirectoryWatcher(
            this.workspaceRoot,
            () => {
                const writes = this.hasActiveOrRecentWrites;
                if (writes) {
                    this._scheduleDeferredRefresh();
                    return;
                }
                this.triggerRefresh({ forceSnapshot: true, reason: 'file watcher event' });
            },
            this.outputChannel,
            'Working Copy Watcher',
            this.watcherBackend,
            this.host,
        );

        this.outputChannel.info(
            `[ChangeDetectionManager] Starting Working Copy Watcher on ${this.workspaceRoot} with backend: ${this.watcherBackend}`,
        );

        await this._workingCopyWatcher.start(ignore);
    }

    private async getSecondaryWorkspacePatterns(): Promise<string[]> {
        try {
            const workspaceList = await this.jj.getWorkspaces();
            this.outputChannel.info(`[ChangeDetectionManager] Workspaces retrieved: ${JSON.stringify(workspaceList)}`);
            const patterns: string[] = [];
            const rootReal = await fs.realpath(this.workspaceRoot).catch(() => this.workspaceRoot);

            for (const ws of workspaceList) {
                const wsReal = await fs.realpath(ws.path).catch(() => ws.path);
                if (wsReal !== rootReal) {
                    const relative = path.relative(rootReal, wsReal);
                    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
                        patterns.push(relative);
                    }
                }
            }
            return patterns;
        } catch (err) {
            this.outputChannel.error(`[ChangeDetectionManager] getSecondaryWorkspacePatterns error: ${err}`);
            return [];
        }
    }

    private async getGitIgnorePatterns(): Promise<string[]> {
        try {
            const gitIgnorePath = path.join(this.workspaceRoot, '.gitignore');
            const data = await fs.readFile(gitIgnorePath, 'utf8');
            return data
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'))
                .map((line) => {
                    // Strip leading/trailing slashes and wildcards to pass as literals.
                    // PARCEL-WATCHER BEHAVIOR:
                    // 1. Literal paths (e.g. 'out') prune all descendants recursively.
                    // 2. Glob patterns (e.g. 'out*') do NOT prune descendants recursively.
                    //
                    // By stripping wildcards we ensure directory contents are ignored, which is the common case
                    // for gitignore patterns like /out/. The caveat is that we lose true wildcard matching
                    // (e.g. /out*/ will only match a directory named exactly 'out').
                    return line.replace(/^[/*?]+|[/*?]+$/g, '');
                })
                .filter((pattern) => pattern.length > 0);
        } catch {
            return [];
        }
    }

    private async getGitModulesPatterns(): Promise<string[]> {
        try {
            const gitModulesPath = path.join(this.workspaceRoot, '.gitmodules');
            const data = await fs.readFile(gitModulesPath, 'utf8');
            const paths: string[] = [];

            const lines = data.split('\n');
            for (const line of lines) {
                const match = line.match(/^\s*path\s*=\s*(.+)$/);
                if (match) {
                    paths.push(match[1].trim());
                }
            }
            return paths;
        } catch {
            return [];
        }
    }

    async dispose() {
        if (this._disposed) {
            return;
        }
        this._disposed = true;

        if (this._deferredRefreshTimeout) {
            clearTimeout(this._deferredRefreshTimeout);
            this._deferredRefreshTimeout = undefined;
        }

        // Run the teardown in the lifecycle queue to serialize after active watcher transitions
        await this._runLifecycleTask(async () => {
            this._poller.stop();

            if (this._workingCopyWatcher) {
                await this._workingCopyWatcher.stop();
                this._workingCopyWatcher = undefined;
            }

            this._poller.dispose();

            if (this._opHeadsWatcher) {
                await this._opHeadsWatcher.dispose();
                this._opHeadsWatcher = undefined;
            }
        });

        this.disposables.forEach((d) => {
            d.dispose();
        });
        this.disposables = [];
    }
}
