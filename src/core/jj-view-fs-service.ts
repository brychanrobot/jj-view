/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Disposable, type Event, EventEmitter } from './host/events';
import type { JjRepository } from './jj-repository';
import type { JjRepositoryManager } from './jj-repository-manager';
import { decodeJjViewQuery, type FileStatLike, getFsPathFromUri, Uri } from './uri-utils';

export type { FileStatLike };

const MAX_CACHE_ENTRIES = 100;

export class JjViewFsService implements Disposable {
    private readonly _onDidChangeFile = new EventEmitter<Uri[]>();
    readonly onDidChangeFile: Event<Uri[]> = this._onDidChangeFile.event;

    // Cache keyed by "base|filePath" → { left, right }
    private readonly _cache = new Map<string, { left: string; right: string }>();
    private readonly _inFlightDiffs = new Map<string, Promise<{ left: string; right: string }>>();
    // Track all URIs that have been served so we can notify when cache invalidates
    private readonly _knownUris = new Set<string>();
    private readonly _watchedUris = new Map<string, number>();
    private _cacheGeneration = 0;
    private _isDisposed = false;

    constructor(private readonly _repositoryManager: JjRepositoryManager) {}

    watch(uri: Uri): Disposable {
        if (this._isDisposed) {
            return { dispose: () => {} };
        }
        const key = uri.toString();
        this._watchedUris.set(key, (this._watchedUris.get(key) || 0) + 1);
        let isDisposed = false;
        return {
            dispose: () => {
                if (isDisposed) {
                    return;
                }
                isDisposed = true;
                this._decrementWatcher(key);
            },
        };
    }

    private _decrementWatcher(key: string): void {
        const count = (this._watchedUris.get(key) || 0) - 1;
        if (count <= 0) {
            this._watchedUris.delete(key);
            return;
        }
        this._watchedUris.set(key, count);
    }

    dispose(): void {
        this._isDisposed = true;
        this._cache.clear();
        this._inFlightDiffs.clear();
        this._knownUris.clear();
        this._watchedUris.clear();
        this._onDidChangeFile.dispose();
    }

    /**
     * Clear the cache and return all known and watched URIs that were affected.
     */
    invalidateCache(): Uri[] {
        if (this._isDisposed) {
            return [];
        }
        this._cacheGeneration++;
        this._cache.clear();
        this._inFlightDiffs.clear();
        const changedUris: Uri[] = [];
        const urisToNotify = new Set<string>([...this._knownUris, ...this._watchedUris.keys()]);
        for (const uriStr of urisToNotify) {
            const uri = Uri.parse(uriStr);
            if (this._repositoryManager.getRepositoryForUri(uri)) {
                changedUris.push(uri);
            }
        }
        this._knownUris.clear();
        if (changedUris.length > 0) {
            this._onDidChangeFile.fire(changedUris);
        }
        return changedUris;
    }

    stat(_uri: Uri): FileStatLike {
        return {
            type: 1, // File
            ctime: 0,
            mtime: 1700000000000 + this._cacheGeneration,
            size: 0,
        };
    }

    async readFile(uri: Uri): Promise<Uint8Array> {
        if (this._isDisposed) {
            return new Uint8Array();
        }
        this._knownUris.add(uri.toString());
        const filePath = getFsPathFromUri(uri);
        const repo = this._repositoryManager.getRepositoryForUri(uri);
        if (!repo) {
            this._repositoryManager.outputChannel.info(
                `[JjViewFsService] No Jujutsu repository resolved for URI: ${uri.toString()} (scheme: ${uri.scheme}, fsPath: ${filePath})`,
            );
            throw new Error(`No Jujutsu repository found for: ${filePath}`);
        }

        try {
            const query = decodeJjViewQuery(uri);
            if (query.mode === 'revision') {
                return await this._readRevisionContent(repo, filePath, query.revision);
            }
            return await this._readDiffContent(repo, filePath, query.base, query.side);
        } catch (err: unknown) {
            this._repositoryManager.outputChannel.debug(
                `[JjViewFsService] Failed to read URI ${uri.toString()}: ${String(err)}`,
            );
            return new Uint8Array();
        }
    }

    private async _readRevisionContent(repo: JjRepository, filePath: string, revision: string): Promise<Uint8Array> {
        try {
            const content = await repo.jj.getFileContent(filePath, revision);
            return Buffer.from(content, 'utf8');
        } catch (err: unknown) {
            this._repositoryManager.outputChannel.debug(
                `[JjViewFsService] Failed to read revision file ${filePath}@${revision}: ${String(err)}`,
            );
            return new Uint8Array();
        }
    }

    private async _readDiffContent(
        repo: JjRepository,
        filePath: string,
        base: string,
        side: 'left' | 'right',
    ): Promise<Uint8Array> {
        const cacheKey = `${base}|${filePath}`;
        let content = this._cache.get(cacheKey);
        if (content) {
            this._cache.delete(cacheKey);
            this._cache.set(cacheKey, content);
        } else {
            const generation = this._cacheGeneration;
            let inFlight = this._inFlightDiffs.get(cacheKey);
            if (!inFlight) {
                inFlight = repo.jj.getDiffContent(base, filePath);
                this._inFlightDiffs.set(cacheKey, inFlight);
            }
            try {
                content = await inFlight;
            } finally {
                if (this._inFlightDiffs.get(cacheKey) === inFlight) {
                    this._inFlightDiffs.delete(cacheKey);
                }
            }
            this._setCacheEntry(cacheKey, content, generation);
        }
        const text = side === 'left' ? content.left : content.right;
        return Buffer.from(text, 'utf8');
    }

    private _setCacheEntry(key: string, content: { left: string; right: string }, generation: number): void {
        if (generation !== this._cacheGeneration || this._isDisposed) {
            return;
        }
        if (this._cache.has(key)) {
            this._cache.delete(key);
        } else if (this._cache.size >= MAX_CACHE_ENTRIES) {
            const oldestKey = this._cache.keys().next().value;
            if (oldestKey) {
                this._cache.delete(oldestKey);
            }
        }
        this._cache.set(key, content);
    }
}
