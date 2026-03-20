/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjStatusEntry } from './jj-types';
import { JjService } from './jj-service';

export class JjDecorationProvider implements vscode.FileDecorationProvider {
    private readonly _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined> =
        new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> =
        this._onDidChangeFileDecorations.event;

    // Parsed from `jj status` (e.g., Modified, Added, Conflict)
    private scmStatusDecorations = new Map<string, JjStatusEntry>();

    private pendingChecks = new Map<string, vscode.Uri>();
    private checkTimeout?: NodeJS.Timeout;

    // Cache to prevent re-evaluating the same file status repeatedly
    private trackedStatusCache = new Map<string, boolean>();
    private resolveCallbacks = new Map<string, (decoration: vscode.FileDecoration | undefined) => void>();

    constructor(
        private jjService: JjService,
        private workspaceRoot: string,
    ) {}

    private _clearIgnoredFileDecorationsCache(): boolean {
        if (this.trackedStatusCache.size > 0 || this.pendingChecks.size > 0) {
            this.trackedStatusCache.clear();
            this.pendingChecks.clear();
            for (const callback of this.resolveCallbacks.values()) {
                callback(undefined);
            }
            this.resolveCallbacks.clear();
            return true;
        }
        return false;
    }

    clearIgnoredFileDecorationsCache() {
        this._clearIgnoredFileDecorationsCache();
        this._onDidChangeFileDecorations.fire(undefined);
    }

    private getScmStatusDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const uriString = uri.toString();
        const scmStatus = this.scmStatusDecorations.get(uriString);
        if (!scmStatus) {
            return undefined;
        }

        const { status, conflicted } = scmStatus;

        if (conflicted) {
            return new vscode.FileDecoration('!', 'Conflicted', new vscode.ThemeColor('jj.conflicted'));
        }

        switch (status) {
            case 'added':
                return new vscode.FileDecoration(
                    'A',
                    'Added',
                    new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
                );
            case 'modified':
                return new vscode.FileDecoration(
                    'M',
                    'Modified',
                    new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
                );
            case 'deleted':
            case 'removed':
                return new vscode.FileDecoration(
                    'D',
                    'Deleted',
                    new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
                );
            case 'renamed':
                return new vscode.FileDecoration(
                    'R',
                    'Renamed',
                    new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
                );
            case 'copied':
                return new vscode.FileDecoration(
                    'C',
                    'Copied',
                    new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
                );
            default:
                return undefined;
        }
    }

    private getWorkspaceRelativePath(uri: vscode.Uri): string | undefined {
        if (!this.workspaceRoot) {
            return undefined;
        }

        const normalizedFsPath = uri.fsPath.replace(/\\/g, '/');
        const normalizedRoot = this.workspaceRoot.replace(/\\/g, '/');

        const isWin = process.platform === 'win32';
        let fsPathMatch = normalizedFsPath;
        let rootMatch = normalizedRoot;

        if (isWin) {
            fsPathMatch = fsPathMatch.toLowerCase();
            rootMatch = rootMatch.toLowerCase();
        }

        if (!fsPathMatch.startsWith(rootMatch)) {
            return undefined;
        }

        let relativePath = normalizedFsPath.substring(normalizedRoot.length);
        if (relativePath.startsWith('/')) {
            relativePath = relativePath.substring(1);
        }
        return relativePath;
    }

    provideFileDecoration(
        uri: vscode.Uri,
        _token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.FileDecoration> {
        // 1. Check if we have an SCM status decoration from jj status
        const scmStatusDecoration = this.getScmStatusDecoration(uri);
        if (scmStatusDecoration) {
            return scmStatusDecoration;
        }

        // 2. Ignore non-file systems or if context not set
        if (uri.scheme !== 'file' || !this.jjService) {
            return undefined;
        }

        // 3. Ignore paths outside our workspace entirely
        const relativePath = this.getWorkspaceRelativePath(uri);
        if (relativePath === undefined) {
            return undefined;
        }

        return this.getTrackedStatusDecoration(uri, relativePath);
    }

    private getTrackedStatusDecoration(
        uri: vscode.Uri,
        relativePath: string,
    ): vscode.ProviderResult<vscode.FileDecoration> {
        // jj intuitively ignores the .jj directory
        if (relativePath === '.jj' || relativePath.startsWith('.jj/') || relativePath.startsWith('.jj\\')) {
            return new vscode.FileDecoration(
                undefined,
                'Ignored',
                new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
            );
        }

        // 4. Check cache for tracked status
        const cachedTrackingStatus = this.trackedStatusCache.get(relativePath);
        if (cachedTrackingStatus === true) {
            return undefined; // Tracked, no gray decoration needed
        } else if (cachedTrackingStatus === false) {
            return new vscode.FileDecoration(
                undefined,
                'Ignored',
                new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
            );
        }

        // 5. Not in cache, schedule a batched check
        return new Promise<vscode.FileDecoration | undefined>((resolve) => {
            this.resolveCallbacks.set(relativePath, resolve);
            this.pendingChecks.set(relativePath, uri);

            if (this.checkTimeout) {
                clearTimeout(this.checkTimeout);
            }

            this.checkTimeout = setTimeout(() => {
                this.flushPendingChecks();
            }, 50);
        });
    }

    private async flushPendingChecks() {
        if (!this.jjService || this.pendingChecks.size === 0) {
            return;
        }

        const pathsToCheck = Array.from(this.pendingChecks.keys());
        const callbacksStr = pathsToCheck.map((p) => ({
            path: p,
            uri: this.pendingChecks.get(p)!,
            resolve: this.resolveCallbacks.get(p)!,
        }));

        this.pendingChecks.clear();
        this.resolveCallbacks.clear();

        try {
            // Ask JJ which of these paths are tracked
            // We use chunking in case the list of visible files is excessively large (unlikely, but safe)
            const chunkSize = 100;
            const trackedSet = new Set<string>();

            for (let i = 0; i < pathsToCheck.length; i += chunkSize) {
                const chunk = pathsToCheck.slice(i, i + chunkSize);
                const trackedArray = await this.jjService.checkTrackedPaths(chunk);
                for (const trackedPath of trackedArray) {
                    // jj output comes with forward slashes usually
                    trackedSet.add(trackedPath.replace(/\\/g, '/'));
                }
            }

            for (const item of callbacksStr) {
                const normalizedItemPath = item.path.replace(/\\/g, '/');

                // Fast exact match (if it's a file)
                let isTracked = trackedSet.has(normalizedItemPath);

                // If not exact match, check prefix (if it's a directory)
                // jj file list <dir> outputs the tracked files inside the directory,
                // e.g., 'dir/file1.txt', 'dir/file2.txt'
                if (!isTracked) {
                    const prefix = normalizedItemPath + '/';
                    for (const trackedFile of trackedSet) {
                        if (trackedFile.startsWith(prefix)) {
                            isTracked = true;
                            break;
                        }
                    }
                }

                this.trackedStatusCache.set(item.path, isTracked);

                if (isTracked) {
                    item.resolve(undefined);
                } else {
                    item.resolve(
                        new vscode.FileDecoration(
                            undefined,
                            'Ignored',
                            new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
                        ),
                    );
                }
            }
        } catch (e) {
            console.error('Failed to check tracked paths', e);
            for (const item of callbacksStr) {
                item.resolve(undefined);
            }
        }
    }

    updateScmStatusAndClearIgnoredCache(scmStatusDecorations: Map<string, JjStatusEntry>) {
        const scmChanged = !this.areDecorationsEqual(this.scmStatusDecorations, scmStatusDecorations);
        if (scmChanged) {
            this.scmStatusDecorations = scmStatusDecorations;
        }
        
        const cacheCleared = this._clearIgnoredFileDecorationsCache();

        if (scmChanged || cacheCleared) {
            this._onDidChangeFileDecorations.fire(undefined); // Refresh all
        }
    }

    private areDecorationsEqual(map1: Map<string, JjStatusEntry>, map2: Map<string, JjStatusEntry>): boolean {
        if (map1.size !== map2.size) {
            return false;
        }

        for (const [key, val1] of map1) {
            const val2 = map2.get(key);
            if (!val2) {
                return false;
            }
            if (val1.path !== val2.path || val1.status !== val2.status || val1.conflicted !== val2.conflicted) {
                return false;
            }
        }
        return true;
    }

    dispose() {
        if (this.checkTimeout) {
            clearTimeout(this.checkTimeout);
        }
        this._onDidChangeFileDecorations.dispose();
    }
}
