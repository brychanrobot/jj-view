/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { BackendType } from '@parcel/watcher';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { DirectoryWatcher } from './directory-watcher';
import { JjService } from './jj-service';
import { Poller } from './poller';

export class ChangeDetectionManager implements vscode.Disposable {
    private _disposed = false;
    private disposables: vscode.Disposable[] = [];

    private _workingCopyWatcher: DirectoryWatcher | undefined;
    private _opHeadsWatcher: DirectoryWatcher | undefined;
    private _poller: Poller;
    private _fileWatcherMode: 'polling' | 'watch' = 'polling';
    private _isFocused = true;
    private lastExternalOpTime = 0;

    private get hasActiveOrRecentWrites(): boolean {
        return (
            this.jj.hasActiveWriteOps ||
            Date.now() - this.jj.lastWriteTime < 500 ||
            Date.now() - this.lastExternalOpTime < 500
        );
    }

    constructor(
        private workspaceRoot: string,
        private jj: JjService,
        private outputChannel: vscode.OutputChannel,
        private triggerRefresh: (event: { forceSnapshot: boolean; reason: string }) => Promise<void>,
        private readonly watcherBackend?: BackendType,
    ) {
        // Initialize poller with 5 second interval
        this._poller = new Poller(5000, async () => {
            // Skip if a write operation is in progress or just finished
            if (!this.hasActiveOrRecentWrites) {
                await this.triggerRefresh({ forceSnapshot: true, reason: 'poll' });
            }
        });

        // 1. Watch for editor saves (catches user edits in VS Code)
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (doc.uri.scheme !== 'file') return;
                if (doc.uri.fsPath.includes('/.jj/')) return;
                this.triggerRefresh({ forceSnapshot: true, reason: 'file saved' });
            }),
        );

        // 2. Poll for external changes or start main watcher
        // Listen for window state changes to pause/resume polling if in polling mode
        this.disposables.push(
            vscode.window.onDidChangeWindowState((state) => {
                this.onWindowStateChange(state);
            }),
        );

        // Initialize focus state
        this._isFocused = vscode.window.state.focused;

        // Listen for configuration changes
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('jj-view.fileWatcherMode')) {
                    this.updateFileWatcherMode();
                }
            }),
        );

        // Initialize watchers
        this.startOpHeadsWatcher();
        this.updateFileWatcherMode();
    }

    private updateFileWatcherMode() {
        const config = vscode.workspace.getConfiguration('jj-view');
        const mode = config.get<'polling' | 'watch'>('fileWatcherMode', 'polling');
        this.outputChannel.appendLine(`[ChangeDetectionManager] File watcher mode: ${mode}`);

        const modeChanged = this._fileWatcherMode !== mode;
        this._fileWatcherMode = mode;

        if (modeChanged) {
            this.stopWorkingCopyWatching();
            this.startWorkingCopyWatching();
        }

        // Always ensure polling state is correct
        this.updatePollingState();
    }

    private onWindowStateChange(state: vscode.WindowState) {
        this._isFocused = state.focused;
        // If getting focused, we want an immediate poll
        this.updatePollingState(state.focused);
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
        if (this._opHeadsWatcher) {
            return;
        }

        let repoRoot: string;
        try {
            repoRoot = await this.jj.getRepoRoot();
        } catch {
            return;
        }

        // Handle non-default workspaces where .jj/repo might be a file containing a path
        const repoStorePath = await this.resolveRepoStorePath(repoRoot);
        if (this._disposed) return;

        const opHeadsPath = path.join(repoStorePath, 'op_heads');

        // Final check that the directory exists and we have a real path
        let realOpHeadsPath: string;
        try {
            realOpHeadsPath = await fs.realpath(opHeadsPath);
        } catch {
            return;
        }

        if (this._disposed) return;

        this._opHeadsWatcher = new DirectoryWatcher(
            realOpHeadsPath,
            () => {
                if (this.hasActiveOrRecentWrites) {
                    return;
                }
                this.lastExternalOpTime = Date.now();
                this.triggerRefresh({ forceSnapshot: false, reason: 'jj operation' });
            },
            this.outputChannel,
            'OpHeads Watcher',
            this.watcherBackend,
        );

        this._opHeadsWatcher.start().catch((err) => {
            this.outputChannel.appendLine(`Failed to start op_heads watcher: ${err}`);
        });
    }

    private async resolveRepoStorePath(workspaceRoot: string): Promise<string> {
        const repoPath = path.join(workspaceRoot, '.jj', 'repo');
        try {
            const stats = await fs.lstat(repoPath);
            if (stats.isFile()) {
                const content = await fs.readFile(repoPath, 'utf8');
                return path.resolve(path.dirname(repoPath), content.trim());
            }
            return await fs.realpath(repoPath);
        } catch {
            return repoPath;
        }
    }

    private async startWorkingCopyWatching() {
        if (this._fileWatcherMode === 'watch') {
            await this.startWorkingCopyWatcherInternal().catch((err) => {
                this.outputChannel.appendLine(`Failed to start working copy watcher: ${err}`);
                this.outputChannel.appendLine('Falling back to polling mode.');
                this._fileWatcherMode = 'polling';
                this.updatePollingState();
            });
        } else {
            this.updatePollingState();
        }
    }

    private async stopWorkingCopyWatching() {
        // Also stop polling if it was active
        this._poller.stop();

        if (this._workingCopyWatcher) {
            await this._workingCopyWatcher.stop();
            this._workingCopyWatcher = undefined;
        }
    }

    private async startWorkingCopyWatcherInternal() {
        if (this._workingCopyWatcher) {
            return;
        }

        const [gitIgnores, gitModules] = await Promise.all([this.getGitIgnorePatterns(), this.getGitModulesPatterns()]);
        if (this._disposed) return;

        const ignore = ['.git', '.jj', '.vscode-test', 'node_modules', ...gitIgnores, ...gitModules];

        this._workingCopyWatcher = new DirectoryWatcher(
            this.workspaceRoot,
            () => {
                if (this.hasActiveOrRecentWrites) {
                    return;
                }
                this.triggerRefresh({ forceSnapshot: true, reason: 'file watcher event' });
            },
            this.outputChannel,
            'Working Copy Watcher',
            this.watcherBackend,
        );

        this.outputChannel.appendLine(
            `[ChangeDetectionManager] Starting Working Copy Watcher on ${this.workspaceRoot} with backend: ${this.watcherBackend}`,
        );

        await this._workingCopyWatcher.start(ignore);
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
                    return line.replace(/^[\/*?]+|[\/*?]+$/g, '');
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

        await this.stopWorkingCopyWatching();
        this._poller.dispose();

        if (this._opHeadsWatcher) {
            await this._opHeadsWatcher.dispose();
            this._opHeadsWatcher = undefined;
        }

        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
    }
}
