/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { type Disposable, type Event, EventEmitter } from './common/events';
import type { JjService } from './jj-service';
import type { JjStatusEntry } from './jj-types';
import { Uri } from './uri-utils';

export interface JjDecoration {
    badge?: string;
    tooltip: string;
    colorKey: string;
    strikethrough?: boolean;
}

export class JjDecorationModel implements Disposable {
    private readonly _onDidChangeDecorations = new EventEmitter<Uri | Uri[] | undefined>();
    readonly onDidChangeDecorations: Event<Uri | Uri[] | undefined> = this._onDidChangeDecorations.event;

    private scmStatusDecorations = new Map<string, JjStatusEntry>();
    private pendingChecks = new Map<string, Uri>();
    private checkTimeout?: NodeJS.Timeout;

    private trackedStatusCache = new Map<string, { isTracked: boolean; uri: Uri }>();
    private resolveCallbacks = new Map<string, (decoration: JjDecoration | undefined) => void>();
    private pendingPromises = new Map<string, Promise<JjDecoration | undefined>>();

    constructor(
        private jjService: JjService,
        private workspaceRoot: string,
    ) {}

    clearIgnoredFileDecorationsCache(): void {
        this.trackedStatusCache.clear();
        this.pendingChecks.clear();
        for (const callback of this.resolveCallbacks.values()) {
            callback(undefined);
        }
        this.resolveCallbacks.clear();
        this.pendingPromises.clear();
        this._onDidChangeDecorations.fire(undefined);
    }

    public getDecoration(uri: Uri): JjDecoration | Promise<JjDecoration | undefined> | undefined {
        const scmStatusDecoration = this.getScmStatusDecoration(uri);
        if (scmStatusDecoration) {
            return scmStatusDecoration;
        }

        if (uri.scheme !== 'file' || !this.jjService) {
            return undefined;
        }

        const relativePath = this.getWorkspaceRelativePath(uri);
        if (relativePath === undefined || relativePath === '') {
            return undefined;
        }

        return this.getTrackedStatusDecoration(uri, relativePath);
    }

    private createDecoration(scmStatus: JjStatusEntry): JjDecoration | undefined {
        const { status, conflicted } = scmStatus;

        if (conflicted) {
            return {
                badge: '!',
                tooltip: 'Conflicted',
                colorKey: 'jj.conflicted',
            };
        }

        switch (status) {
            case 'added':
                return {
                    badge: 'A',
                    tooltip: 'Added',
                    colorKey: 'gitDecoration.addedResourceForeground',
                };
            case 'modified':
                return {
                    badge: 'M',
                    tooltip: 'Modified',
                    colorKey: 'gitDecoration.modifiedResourceForeground',
                };
            case 'deleted':
                return {
                    badge: 'D',
                    tooltip: 'Deleted',
                    colorKey: 'gitDecoration.deletedResourceForeground',
                };
            case 'renamed':
                return {
                    badge: 'R',
                    tooltip: 'Renamed',
                    colorKey: 'gitDecoration.modifiedResourceForeground',
                };
            case 'copied':
                return {
                    badge: 'C',
                    tooltip: 'Copied',
                    colorKey: 'gitDecoration.addedResourceForeground',
                };
            default:
                return undefined;
        }
    }

    private getScmStatusDecoration(uri: Uri): JjDecoration | undefined {
        if (uri.scheme === 'jj-edit' || uri.scheme === 'jj-view') {
            const scmStatus = this.scmStatusDecorations.get(uri.toString());
            if (scmStatus) {
                return this.createDecoration(scmStatus);
            }
        }

        const relativePath = this.getWorkspaceRelativePath(uri);
        if (!relativePath) {
            return undefined;
        }
        const key = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
        const scmStatus = this.scmStatusDecorations.get(key) || this.scmStatusDecorations.get(uri.toString());
        return scmStatus ? this.createDecoration(scmStatus) : undefined;
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

    private getTrackedStatusDecoration(
        uri: Uri,
        relativePath: string,
    ): JjDecoration | Promise<JjDecoration | undefined> | undefined {
        if (relativePath === '.jj' || relativePath.startsWith('.jj/') || relativePath.startsWith('.jj\\')) {
            return {
                tooltip: 'Ignored',
                colorKey: 'gitDecoration.ignoredResourceForeground',
            };
        }

        const cacheEntry = this.trackedStatusCache.get(relativePath);
        if (cacheEntry) {
            return cacheEntry.isTracked
                ? undefined
                : {
                      tooltip: 'Ignored',
                      colorKey: 'gitDecoration.ignoredResourceForeground',
                  };
        }

        const pending = this.pendingPromises.get(relativePath);
        if (pending) {
            return pending;
        }

        const promise = new Promise<JjDecoration | undefined>((resolve) => {
            this.resolveCallbacks.set(relativePath, resolve);
            this.queueCheck(uri, relativePath);
        });
        this.pendingPromises.set(relativePath, promise);
        return promise;
    }

    private queueCheck(uri: Uri, relativePath: string): void {
        this.pendingChecks.set(relativePath, uri);

        if (this.checkTimeout) {
            clearTimeout(this.checkTimeout);
        }

        this.checkTimeout = setTimeout(() => {
            this.flushPendingChecks();
        }, 50);
    }

    private async flushPendingChecks(): Promise<void> {
        if (!this.jjService || this.pendingChecks.size === 0) {
            return;
        }

        const pathsToCheck = Array.from(this.pendingChecks.keys());
        const callbacksStr: {
            path: string;
            uri: Uri;
            resolve?: (decoration: JjDecoration | undefined) => void;
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
            const chunkSize = 100;
            const trackedSet = new Set<string>();

            for (let i = 0; i < pathsToCheck.length; i += chunkSize) {
                const chunk = pathsToCheck.slice(i, i + chunkSize);
                const trackedArray = await this.jjService.checkTrackedPaths(chunk);
                for (const trackedPath of trackedArray) {
                    trackedSet.add(trackedPath.replace(/\\/g, '/'));
                }
            }

            for (const item of callbacksStr) {
                const normalizedItemPath = item.path.replace(/\\/g, '/');

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

                const oldStatus = this.trackedStatusCache.get(item.path)?.isTracked;
                this.trackedStatusCache.set(item.path, { isTracked, uri: item.uri });

                const { resolve } = item;
                if (resolve) {
                    if (isTracked) {
                        resolve(undefined);
                    } else {
                        resolve({
                            tooltip: 'Ignored',
                            colorKey: 'gitDecoration.ignoredResourceForeground',
                        });
                    }
                } else if (oldStatus !== undefined && oldStatus !== isTracked) {
                    this._onDidChangeDecorations.fire(item.uri);
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

    private async updateTrackedStatusDecorations(): Promise<void> {
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
                this._onDidChangeDecorations.fire(changedUris);
            }
        } catch (e) {
            console.error('Failed to revalidate tracked cache', e);
        }
    }

    private updateScmStatusDecorations(scmStatusDecorations: Map<string, JjStatusEntry>): void {
        const changedUris: Uri[] = [];

        const relativeKeyToUri = (key: string): Uri => {
            if (key.startsWith('file:') || key.startsWith('jj-edit:') || key.startsWith('jj-view:')) {
                return Uri.parse(key);
            }
            const relKey = key.replace(/^[/\\]+/, '');
            return Uri.file(path.join(this.workspaceRoot, relKey));
        };

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
            this._onDidChangeDecorations.fire(changedUris);
        }
    }

    updateScmAndTrackedStatus(scmStatusDecorations: Map<string, JjStatusEntry>): void {
        this.updateScmStatusDecorations(scmStatusDecorations);
        this.updateTrackedStatusDecorations();
    }

    dispose(): void {
        if (this.checkTimeout) {
            clearTimeout(this.checkTimeout);
        }
        this._onDidChangeDecorations.dispose();
    }
}
