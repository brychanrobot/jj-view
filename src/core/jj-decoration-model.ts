/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'pathe';
import { type Disposable, type Event, EventEmitter } from './host/events';
import type { HostFs } from './host/host-system';
import type { JjService } from './jj-service';
import type { JjStatusEntry } from './jj-types';
import {
    getRepoRelativePath,
    getUriParams,
    isInsideRelativePath,
    normalizeDriveLetter,
    resolvePathAgainstRealRootAsync,
    toForwardSlash,
    Uri,
} from './uri-utils';

export interface JjDecoration {
    badge?: string;
    tooltip: string;
    colorKey: string;
    strikethrough?: boolean;
}

interface TrackedStatusCacheEntry {
    isTracked: boolean;
    uri: Uri;
    resolvedRelativePath?: string;
}

interface TrackedPathResult {
    isTracked: boolean;
    resolvedRelativePath?: string;
}

function isPathInTrackedSet(targetPath: string, trackedSet: ReadonlySet<string>): boolean {
    if (trackedSet.has(targetPath)) {
        return true;
    }
    const prefix = `${targetPath}/`;
    for (const trackedFile of trackedSet) {
        if (trackedFile.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}

function isIgnoredJjPath(relativePath: string): boolean {
    const forward = toForwardSlash(relativePath);
    return forward === '.jj' || forward.startsWith('.jj/');
}

export class JjDecorationModel implements Disposable {
    private readonly _onDidChangeDecorations = new EventEmitter<Uri | Uri[] | undefined>();
    readonly onDidChangeDecorations: Event<Uri | Uri[] | undefined> = this._onDidChangeDecorations.event;

    private scmStatusDecorations = new Map<string, JjStatusEntry>();
    private pendingChecks = new Map<string, Uri>();
    private checkTimeout?: NodeJS.Timeout;

    private trackedStatusCache = new Map<string, TrackedStatusCacheEntry>();
    private resolveCallbacks = new Map<string, (decoration: JjDecoration | undefined) => void>();
    private pendingPromises = new Map<string, Promise<JjDecoration | undefined>>();
    private workspaceRealCache?: string;
    private cacheGeneration = 0;
    private revalidationGeneration = 0;

    constructor(
        private jjService: JjService,
        private workspaceRoot: string,
    ) {}

    private cancelPendingChecks(): void {
        if (this.checkTimeout) {
            clearTimeout(this.checkTimeout);
            this.checkTimeout = undefined;
        }
        this.pendingChecks.clear();
        for (const callback of this.resolveCallbacks.values()) {
            callback(undefined);
        }
        this.resolveCallbacks.clear();
        this.pendingPromises.clear();
    }

    clearIgnoredFileDecorationsCache(): void {
        this.cacheGeneration++;
        this.revalidationGeneration++;
        this.trackedStatusCache.clear();
        this.cancelPendingChecks();
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

    private createIgnoredDecoration(): JjDecoration {
        return {
            tooltip: 'Ignored',
            colorKey: 'gitDecoration.ignoredResourceForeground',
        };
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

    private getScmStatusEntryByRelativePath(relativePath: string): JjStatusEntry | undefined {
        const clean = toForwardSlash(relativePath).replace(/^\/+|\/+$/g, '');
        if (!clean) {
            return undefined;
        }
        return this.scmStatusDecorations.get(`/${clean}`) ?? this.scmStatusDecorations.get(clean);
    }

    private getScmStatusDecoration(uri: Uri): JjDecoration | undefined {
        const directUriStatus = this.scmStatusDecorations.get(uri.toString());
        if (directUriStatus) {
            return this.createDecoration(directUriStatus);
        }

        const relativePath = this.getWorkspaceRelativePath(uri);
        if (!relativePath) {
            return undefined;
        }

        const scmStatus = this.getScmStatusEntryByRelativePath(relativePath);
        if (scmStatus) {
            return this.createDecoration(scmStatus);
        }

        if (uri.scheme === 'jj-edit' || uri.scheme === 'jj-view') {
            return undefined;
        }

        const cached = this.trackedStatusCache.get(relativePath);
        if (cached?.resolvedRelativePath) {
            const resolvedStatus = this.getScmStatusEntryByRelativePath(cached.resolvedRelativePath);
            if (resolvedStatus) {
                return this.createDecoration(resolvedStatus);
            }
        }

        return undefined;
    }

    private isWinPlatform(): boolean {
        return (
            (this.jjService?.system?.platform ?? (typeof process !== 'undefined' ? process.platform : undefined)) ===
            'win32'
        );
    }

    private extractRelativeFromRoot(fsPath: string, rootPath: string, isWin: boolean): string | undefined {
        const normFsPath = toForwardSlash(path.normalize(fsPath));
        const rawNormRoot = toForwardSlash(path.normalize(rootPath));
        const normRoot = rawNormRoot.length > 1 ? rawNormRoot.replace(/\/+$/, '') : rawNormRoot;

        const fsPathMatch = isWin ? normalizeDriveLetter(normFsPath).toLowerCase() : normFsPath;
        const rootMatch = isWin ? normalizeDriveLetter(normRoot).toLowerCase() : normRoot;

        if (fsPathMatch === rootMatch) {
            return '';
        }
        const isDriveOrFsRoot = rootMatch === '/' || /^[a-z]:\/$/.test(rootMatch);
        const rootPrefix = isDriveOrFsRoot ? rootMatch : `${rootMatch}/`;
        if (!fsPathMatch.startsWith(rootPrefix)) {
            return undefined;
        }
        const normPrefixLen = isDriveOrFsRoot ? normRoot.length : normRoot.length + 1;
        return normFsPath.slice(normPrefixLen).replace(/\/+$/, '');
    }

    private getCachedOrSyncWorkspaceReal(): string | undefined {
        if (this.workspaceRealCache !== undefined) {
            return this.workspaceRealCache;
        }
        const realpathSync = this.jjService?.system?.fs?.realpathSync;
        if (typeof realpathSync !== 'function') {
            return undefined;
        }
        try {
            this.workspaceRealCache = realpathSync(this.workspaceRoot);
            return this.workspaceRealCache;
        } catch {
            return undefined;
        }
    }

    private getWorkspaceRelativePath(uri: Uri): string | undefined {
        if (!this.workspaceRoot) {
            return undefined;
        }
        if (uri.scheme === 'jj-edit' || uri.scheme === 'jj-view') {
            const params = getUriParams(uri);
            const embeddedRoot = params.get('root') || params.get('repoRoot');
            if (embeddedRoot) {
                const normEmbedded = toForwardSlash(normalizeDriveLetter(embeddedRoot)).replace(/\/+$/, '');
                const normWorkspace = toForwardSlash(normalizeDriveLetter(this.workspaceRoot)).replace(/\/+$/, '');
                if (normEmbedded !== normWorkspace) {
                    return undefined;
                }
            }
            const rel = getRepoRelativePath(uri, this.workspaceRoot);
            const clean = rel.startsWith('/') ? rel.substring(1) : rel;
            return isInsideRelativePath(clean) ? clean : undefined;
        }

        const isWin = this.isWinPlatform();
        const directRel = this.extractRelativeFromRoot(uri.fsPath, this.workspaceRoot, isWin);
        if (directRel !== undefined) {
            return directRel;
        }

        const workspaceReal = this.getCachedOrSyncWorkspaceReal();
        if (workspaceReal && workspaceReal !== this.workspaceRoot) {
            return this.extractRelativeFromRoot(uri.fsPath, workspaceReal, isWin);
        }

        return undefined;
    }

    private getTrackedStatusDecoration(
        uri: Uri,
        relativePath: string,
    ): JjDecoration | Promise<JjDecoration | undefined> | undefined {
        if (isIgnoredJjPath(relativePath)) {
            return this.createIgnoredDecoration();
        }

        const cacheEntry = this.trackedStatusCache.get(relativePath);
        if (cacheEntry) {
            return cacheEntry.isTracked ? undefined : this.createIgnoredDecoration();
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
            this.checkTimeout = undefined;
            void this.flushPendingChecks();
        }, 50);
    }

    private async fetchTrackedSet(paths: readonly string[]): Promise<Set<string>> {
        const trackedSet = new Set<string>();
        const chunkSize = 100;
        for (let i = 0; i < paths.length; i += chunkSize) {
            const chunk = paths.slice(i, i + chunkSize);
            const trackedArray = await this.jjService.checkTrackedPaths([...chunk]);
            for (const trackedPath of trackedArray) {
                trackedSet.add(toForwardSlash(trackedPath));
            }
        }
        return trackedSet;
    }

    private async resolveJjWorkspaceReal(): Promise<string> {
        const jjRoot = this.jjService.workspaceRoot || this.workspaceRoot;
        const sameRoot = toForwardSlash(path.normalize(jjRoot)) === toForwardSlash(path.normalize(this.workspaceRoot));
        if (typeof this.jjService.getWorkspaceReal === 'function') {
            const real = await this.jjService.getWorkspaceReal();
            if (sameRoot && real !== this.workspaceRoot) {
                this.workspaceRealCache = real;
            }
            return real;
        }
        const fs = this.jjService.system?.fs;
        if (!fs) {
            return jjRoot;
        }
        try {
            const real = await fs.realpath(jjRoot);
            if (sameRoot) {
                this.workspaceRealCache = real;
            }
            return real;
        } catch {
            return jjRoot;
        }
    }

    private async resolveSymlinkTargets(
        misses: ReadonlyArray<{ lexicalPath: string; normalizedLexicalPath: string; uri: Uri }>,
        fs: HostFs,
    ): Promise<Map<string, string>> {
        const workspaceReal = await this.resolveJjWorkspaceReal();
        const resolvedTargets = new Map<string, string>();

        await Promise.all(
            misses.map(async (miss) => {
                try {
                    const fsPathToResolve = miss.uri.fsPath || path.join(this.workspaceRoot, miss.lexicalPath);
                    const resolution = await resolvePathAgainstRealRootAsync(fsPathToResolve, workspaceReal, fs);
                    if (!resolution?.inside) {
                        return;
                    }
                    const resolvedRel = toForwardSlash(resolution.relativePath).replace(/^\/+|\/+$/g, '');
                    const normalizedResolved = resolvedRel === '.' ? '' : resolvedRel;
                    if (
                        !normalizedResolved ||
                        normalizedResolved === miss.normalizedLexicalPath ||
                        isIgnoredJjPath(normalizedResolved)
                    ) {
                        return;
                    }
                    resolvedTargets.set(miss.lexicalPath, normalizedResolved);
                } catch {
                    // Broken symlinks, ELOOP, or unreadable targets stay untracked/ignored.
                }
            }),
        );

        return resolvedTargets;
    }

    /**
     * Checks tracked status for workspace-relative items.
     * Fast path queries lexical paths first so normal tracked files and tracked
     * symlink entries themselves never invoke `fs.realpath`. Only lexical misses
     * resolve canonical paths inside `workspaceRoot` via `resolvePathAgainstRealRootAsync`
     * and batch-query their unique resolved targets.
     */
    private async checkPathsWithSymlinkFallback(
        items: ReadonlyArray<{ lexicalPath: string; uri: Uri }>,
    ): Promise<Map<string, TrackedPathResult>> {
        const lexicalPaths = items.map((item) => item.lexicalPath);
        const lexicalTrackedSet = await this.fetchTrackedSet(lexicalPaths);

        const results = new Map<string, TrackedPathResult>();
        const misses: Array<{ lexicalPath: string; normalizedLexicalPath: string; uri: Uri }> = [];

        for (const item of items) {
            const normalizedLexicalPath = toForwardSlash(item.lexicalPath);
            if (isPathInTrackedSet(normalizedLexicalPath, lexicalTrackedSet)) {
                results.set(item.lexicalPath, { isTracked: true });
            } else {
                misses.push({ lexicalPath: item.lexicalPath, normalizedLexicalPath, uri: item.uri });
            }
        }

        if (misses.length === 0) {
            return results;
        }

        const fs = this.jjService.system?.fs;
        if (!fs) {
            for (const miss of misses) {
                results.set(miss.lexicalPath, { isTracked: false });
            }
            return results;
        }

        const resolvedTargets = await this.resolveSymlinkTargets(misses, fs);
        const uniqueResolvedPaths = new Set(resolvedTargets.values());
        const resolvedTrackedSet =
            uniqueResolvedPaths.size > 0
                ? await this.fetchTrackedSet(Array.from(uniqueResolvedPaths))
                : new Set<string>();

        for (const miss of misses) {
            const resolvedRel = resolvedTargets.get(miss.lexicalPath);
            if (!resolvedRel) {
                results.set(miss.lexicalPath, { isTracked: false });
                continue;
            }
            const isTracked = isPathInTrackedSet(resolvedRel, resolvedTrackedSet);
            results.set(miss.lexicalPath, { isTracked, resolvedRelativePath: resolvedRel });
        }

        return results;
    }

    private resolveTrackedDecoration(lexicalPath: string, result: TrackedPathResult): JjDecoration | undefined {
        const lexicalScm = this.getScmStatusEntryByRelativePath(lexicalPath);
        if (lexicalScm) {
            return this.createDecoration(lexicalScm);
        }
        if (result.resolvedRelativePath) {
            const resolvedScm = this.getScmStatusEntryByRelativePath(result.resolvedRelativePath);
            if (resolvedScm) {
                return this.createDecoration(resolvedScm);
            }
        }
        return result.isTracked ? undefined : this.createIgnoredDecoration();
    }

    private async flushPendingChecks(): Promise<void> {
        if (!this.jjService || this.pendingChecks.size === 0) {
            return;
        }

        const generation = this.cacheGeneration;
        const items: Array<{
            lexicalPath: string;
            uri: Uri;
            resolve?: (decoration: JjDecoration | undefined) => void;
        }> = [];
        for (const [lexicalPath, uri] of this.pendingChecks.entries()) {
            items.push({
                lexicalPath,
                uri,
                resolve: this.resolveCallbacks.get(lexicalPath),
            });
        }

        this.pendingChecks.clear();
        this.resolveCallbacks.clear();
        for (const item of items) {
            this.pendingPromises.delete(item.lexicalPath);
        }

        try {
            const results = await this.checkPathsWithSymlinkFallback(items);
            if (generation !== this.cacheGeneration) {
                for (const item of items) {
                    item.resolve?.(undefined);
                }
                return;
            }

            for (const item of items) {
                const result = results.get(item.lexicalPath) ?? { isTracked: false };
                const oldStatus = this.trackedStatusCache.get(item.lexicalPath)?.isTracked;
                this.trackedStatusCache.set(item.lexicalPath, {
                    isTracked: result.isTracked,
                    uri: item.uri,
                    resolvedRelativePath: result.resolvedRelativePath,
                });

                const decoration = this.resolveTrackedDecoration(item.lexicalPath, result);
                if (item.resolve) {
                    item.resolve(decoration);
                } else if (oldStatus !== undefined && oldStatus !== result.isTracked) {
                    this._onDidChangeDecorations.fire(item.uri);
                }
            }
        } catch (e) {
            console.error('Failed to check tracked paths', e);
            for (const item of items) {
                item.resolve?.(undefined);
            }
        }
    }

    /**
     * Revalidates all cached tracked-status entries and notifies listeners when
     * tracked state or SCM-decorated symlink target mappings change.
     */
    public async updateTrackedStatusDecorations(): Promise<void> {
        if (!this.jjService || this.trackedStatusCache.size === 0) {
            return;
        }

        const generation = this.cacheGeneration;
        const revalidationGen = ++this.revalidationGeneration;
        const entries = Array.from(this.trackedStatusCache.entries());
        const items = entries.map(([lexicalPath, cacheEntry]) => ({ lexicalPath, uri: cacheEntry.uri }));

        try {
            const results = await this.checkPathsWithSymlinkFallback(items);
            if (generation !== this.cacheGeneration || revalidationGen !== this.revalidationGeneration) {
                return;
            }

            const changedUris: Uri[] = [];

            for (const [itemPath, cacheEntry] of entries) {
                const result = results.get(itemPath);
                if (!result) {
                    continue;
                }
                const nextResolved = result.resolvedRelativePath;
                const statusChanged = cacheEntry.isTracked !== result.isTracked;
                const resolvedChanged = cacheEntry.resolvedRelativePath !== nextResolved;

                if (statusChanged || resolvedChanged) {
                    this.trackedStatusCache.set(itemPath, {
                        isTracked: result.isTracked,
                        uri: cacheEntry.uri,
                        resolvedRelativePath: nextResolved,
                    });
                }

                if (statusChanged) {
                    changedUris.push(cacheEntry.uri);
                } else if (resolvedChanged) {
                    const hadOldScm = cacheEntry.resolvedRelativePath
                        ? this.getScmStatusEntryByRelativePath(cacheEntry.resolvedRelativePath) !== undefined
                        : false;
                    const hasNewScm = nextResolved
                        ? this.getScmStatusEntryByRelativePath(nextResolved) !== undefined
                        : false;
                    if (hadOldScm || hasNewScm) {
                        changedUris.push(cacheEntry.uri);
                    }
                }
            }

            if (changedUris.length > 0) {
                this._onDidChangeDecorations.fire(changedUris);
            }
        } catch (e) {
            console.error('Failed to revalidate tracked cache', e);
        }
    }

    private extractScmRelativePath(key: string): string | undefined {
        if (key.startsWith('jj-edit:') || key.startsWith('jj-view:')) {
            return undefined;
        }
        if (key.startsWith('file:')) {
            return this.getWorkspaceRelativePath(Uri.parse(key)) || undefined;
        }
        const clean = toForwardSlash(key).replace(/^\/+|\/+$/g, '');
        return clean || undefined;
    }

    private updateScmStatusDecorations(scmStatusDecorations: Map<string, JjStatusEntry>): void {
        const changedUris: Uri[] = [];
        const seenUriKeys = new Set<string>();
        const changedRelativePaths = new Set<string>();

        const pushUniqueUri = (uri: Uri): void => {
            const uriKey = uri.toString();
            if (!seenUriKeys.has(uriKey)) {
                seenUriKeys.add(uriKey);
                changedUris.push(uri);
            }
        };

        const relativeKeyToUri = (key: string): Uri => {
            if (key.startsWith('file:') || key.startsWith('jj-edit:') || key.startsWith('jj-view:')) {
                return Uri.parse(key);
            }
            const relKey = key.replace(/^[/\\]+/, '');
            return Uri.file(path.join(this.workspaceRoot, relKey));
        };

        const recordChangedKey = (key: string): void => {
            pushUniqueUri(relativeKeyToUri(key));
            const rel = this.extractScmRelativePath(key);
            if (rel) {
                changedRelativePaths.add(rel);
            }
        };

        for (const [key, newEntry] of scmStatusDecorations.entries()) {
            const oldEntry = this.scmStatusDecorations.get(key);
            if (!oldEntry || oldEntry.status !== newEntry.status || oldEntry.conflicted !== newEntry.conflicted) {
                recordChangedKey(key);
            }
        }
        for (const key of this.scmStatusDecorations.keys()) {
            if (!scmStatusDecorations.has(key)) {
                recordChangedKey(key);
            }
        }

        if (changedRelativePaths.size > 0) {
            for (const [itemPath, cacheEntry] of this.trackedStatusCache.entries()) {
                if (
                    (cacheEntry.resolvedRelativePath && changedRelativePaths.has(cacheEntry.resolvedRelativePath)) ||
                    changedRelativePaths.has(itemPath)
                ) {
                    pushUniqueUri(cacheEntry.uri);
                }
            }
        }

        this.scmStatusDecorations = scmStatusDecorations;

        if (changedUris.length > 0) {
            this._onDidChangeDecorations.fire(changedUris);
        }
    }

    updateScmAndTrackedStatus(scmStatusDecorations: Map<string, JjStatusEntry>): void {
        this.updateScmStatusDecorations(scmStatusDecorations);
        void this.updateTrackedStatusDecorations();
    }

    dispose(): void {
        this.cacheGeneration++;
        this.revalidationGeneration++;
        this.cancelPendingChecks();
        this._onDidChangeDecorations.dispose();
    }
}
