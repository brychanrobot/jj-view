/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { JjService } from './jj-service';
import type { JjStatusEntry } from './jj-types';
import { Uri } from './uri-utils';

export class JjDecorationProvider implements vscode.FileDecorationProvider {
    private readonly _onDidChangeFileDecorations: vscode.EventEmitter<Uri | Uri[] | undefined> =
        new vscode.EventEmitter<Uri | Uri[] | undefined>();
    readonly onDidChangeFileDecorations: vscode.Event<Uri | Uri[] | undefined> = this._onDidChangeFileDecorations.event;

    // Parsed from `jj status` (e.g., Modified, Added, Conflict)
    private scmStatusDecorations = new Map<string, JjStatusEntry>();

    private pendingChecks = new Map<string, Uri>();
    private checkTimeout?: NodeJS.Timeout;

    // Cache to prevent re-evaluating the same file status repeatedly
    private trackedStatusCache = new Map<string, { isTracked: boolean; uri: Uri }>();
    private resolveCallbacks = new Map<string, (decoration: vscode.FileDecoration | undefined) => void>();
    private pendingPromises = new Map<string, Promise<vscode.FileDecoration | undefined>>();

    constructor(
        private jjService: JjService,
        private workspaceRoot: string,
    ) {}

    clearIgnoredFileDecorationsCache() {
        this.trackedStatusCache.clear();
        this.pendingChecks.clear();
        for (const callback of this.resolveCallbacks.values()) {
            callback(undefined);
        }
        this.resolveCallbacks.clear();
        this.pendingPromises.clear();
        this._onDidChangeFileDecorations.fire(undefined);
    }

    private createFileDecoration(scmStatus: JjStatusEntry): vscode.FileDecoration | undefined {
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

    private getScmStatusDecoration(uri: Uri): vscode.FileDecoration | undefined {
        if (uri.scheme === 'jj-edit' || uri.scheme === 'jj-view') {
            const scmStatus = this.scmStatusDecorations.get(uri.toString());
            if (scmStatus) {
                return this.createFileDecoration(scmStatus);
            }
        }

        const relativePath = this.getWorkspaceRelativePath(uri);
        if (!relativePath) {
            return undefined;
        }
        const key = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
        const scmStatus = this.scmStatusDecorations.get(key) || this.scmStatusDecorations.get(uri.toString());
        return scmStatus ? this.createFileDecoration(scmStatus) : undefined;
    }

    private getWorkspaceRelativePath(uri: Uri): string | undefined {
        if (!this.workspaceRoot) {
            return undefined;
        }
        if (uri.scheme === 'jj-edit' || uri.scheme === 'jj-view') {
            const rel = uri.path;
            return rel.startsWith('/') ? rel.substring(1) : rel;
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

    provideFileDecoration(uri: Uri, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
        // 1. Check if we have an SCM status decoration from jj status
        const scmStatusDecoration = this.getScmStatusDecoration(uri);
        if (scmStatusDecoration) {
            return scmStatusDecoration;
        }

        // 2. Ignore non-file systems or if context not set
        if (uri.scheme !== 'file' || !this.jjService) {
            return undefined;
        }

        // 3. Ignore paths outside our workspace entirely or the workspace root itself
        const relativePath = this.getWorkspaceRelativePath(uri);
        if (relativePath === undefined || relativePath === '') {
            return undefined;
        }

        return this.getTrackedStatusDecoration(uri, relativePath);
    }

    private getTrackedStatusDecoration(uri: Uri, relativePath: string): vscode.ProviderResult<vscode.FileDecoration> {
        // jj intuitively ignores the .jj directory
        if (relativePath === '.jj' || relativePath.startsWith('.jj/') || relativePath.startsWith('.jj\\')) {
            return new vscode.FileDecoration(
                undefined,
                'Ignored',
                new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
            );
        }

        // 4. Check cache for tracked status
        const cacheEntry = this.trackedStatusCache.get(relativePath);
        if (cacheEntry) {
            return cacheEntry.isTracked
                ? undefined
                : new vscode.FileDecoration(
                      undefined,
                      'Ignored',
                      new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
                  );
        }

        // 5. Check if there's already a pending promise for this path
        const pending = this.pendingPromises.get(relativePath);
        if (pending) {
            return pending;
        }

        // 6. Not in cache and no pending promise, create a new promise and schedule a batched check
        const promise = new Promise<vscode.FileDecoration | undefined>((resolve) => {
            this.resolveCallbacks.set(relativePath, resolve);
            this.queueCheck(uri, relativePath);
        });
        this.pendingPromises.set(relativePath, promise);
        return promise;
    }

    private queueCheck(uri: Uri, relativePath: string) {
        this.pendingChecks.set(relativePath, uri);

        if (this.checkTimeout) {
            clearTimeout(this.checkTimeout);
        }

        this.checkTimeout = setTimeout(() => {
            this.flushPendingChecks();
        }, 50);
    }

    private async flushPendingChecks() {
        if (!this.jjService || this.pendingChecks.size === 0) {
            return;
        }

        const pathsToCheck = Array.from(this.pendingChecks.keys());
        const callbacksStr: {
            path: string;
            uri: Uri;
            resolve?: (decoration: vscode.FileDecoration | undefined) => void;
        }[] = [];
        for (const p of pathsToCheck) {
            const uri = this.pendingChecks.get(p);
            if (uri) {
                callbacksStr.push({
                    path: p,
                    uri,
                    resolve: this.resolveCallbacks.get(p),
                });
            }
        }

        this.pendingChecks.clear();
        this.resolveCallbacks.clear();
        for (const p of pathsToCheck) {
            this.pendingPromises.delete(p);
        }

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
                    const prefix = `${normalizedItemPath}/`;
                    for (const trackedFile of trackedSet) {
                        if (trackedFile.startsWith(prefix)) {
                            isTracked = true;
                            break;
                        }
                    }
                }

                const oldStatus = this.trackedStatusCache.get(item.path)?.isTracked;
                this.trackedStatusCache.set(item.path, { isTracked, uri: item.uri });

                const { resolve } = item;
                if (resolve) {
                    if (isTracked) {
                        resolve(undefined);
                    } else {
                        resolve(
                            new vscode.FileDecoration(
                                undefined,
                                'Ignored',
                                new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
                            ),
                        );
                    }
                } else if (oldStatus !== undefined && oldStatus !== isTracked) {
                    this._onDidChangeFileDecorations.fire(item.uri);
                }
            }
        } catch (e) {
            console.error('Failed to check tracked paths', e);
            for (const item of callbacksStr) {
                if (item.resolve) {
                    item.resolve(undefined);
                }
            }
        }
    }

    private async updateTrackedStatusDecorations() {
        if (!this.jjService || this.trackedStatusCache.size === 0) {
            return;
        }

        const entries = Array.from(this.trackedStatusCache.entries());
        const pathsToCheck = entries.map(([p]) => p);

        try {
            const chunkSize = 100;
            const trackedSet = new Set<string>();

            for (let i = 0; i < pathsToCheck.length; i += chunkSize) {
                const chunk = pathsToCheck.slice(i, i + chunkSize);
                const trackedArray = await this.jjService.checkTrackedPaths(chunk);
                for (const trackedPath of trackedArray) {
                    trackedSet.add(trackedPath.replace(/\\/g, '/'));
                }
            }

            const changedUris: Uri[] = [];

            for (const [itemPath, cacheEntry] of entries) {
                const normalizedItemPath = itemPath.replace(/\\/g, '/');
                let isTracked = trackedSet.has(normalizedItemPath);

                if (!isTracked) {
                    const prefix = `${normalizedItemPath}/`;
                    for (const trackedFile of trackedSet) {
                        if (trackedFile.startsWith(prefix)) {
                            isTracked = true;
                            break;
                        }
                    }
                }

                if (cacheEntry.isTracked !== isTracked) {
                    this.trackedStatusCache.set(itemPath, { isTracked, uri: cacheEntry.uri });
                    changedUris.push(cacheEntry.uri);
                }
            }

            if (changedUris.length > 0) {
                this._onDidChangeFileDecorations.fire(changedUris);
            }
        } catch (e) {
            console.error('Failed to revalidate tracked cache', e);
        }
    }

    private updateScmStatusDecorations(scmStatusDecorations: Map<string, JjStatusEntry>) {
        const changedUris: Uri[] = [];

        const relativeKeyToUri = (key: string): Uri => {
            if (key.startsWith('file:') || key.startsWith('jj-edit:') || key.startsWith('jj-view:')) {
                return Uri.parse(key);
            }
            const relKey = key.replace(/^[/\\]+/, '');
            return Uri.file(path.join(this.workspaceRoot, relKey));
        };

        // Compare old and new SCM status
        for (const [key, newEntry] of scmStatusDecorations.entries()) {
            const oldEntry = this.scmStatusDecorations.get(key);
            if (!oldEntry || oldEntry.status !== newEntry.status || oldEntry.conflicted !== newEntry.conflicted) {
                changedUris.push(relativeKeyToUri(key));
            }
        }
        for (const key of this.scmStatusDecorations.keys()) {
            if (!scmStatusDecorations.has(key)) {
                changedUris.push(relativeKeyToUri(key));
            }
        }

        this.scmStatusDecorations = scmStatusDecorations;

        if (changedUris.length > 0) {
            this._onDidChangeFileDecorations.fire(changedUris);
        }
    }

    updateScmAndTrackedStatus(scmStatusDecorations: Map<string, JjStatusEntry>) {
        this.updateScmStatusDecorations(scmStatusDecorations);
        this.updateTrackedStatusDecorations();
    }

    dispose() {
        if (this.checkTimeout) {
            clearTimeout(this.checkTimeout);
        }
        this._onDidChangeFileDecorations.dispose();
    }
}
