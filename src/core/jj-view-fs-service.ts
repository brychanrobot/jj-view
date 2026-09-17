/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncCache } from '../utils/async-cache';
import type { Disposable, Event } from './host/events';
import type { JjRepository } from './jj-repository';
import type { JjRepositoryManager } from './jj-repository-manager';
import { decodeJjViewQuery, type FileStatLike, getFsPathFromUri, type Uri } from './uri-utils';
import { VirtualFsUriTracker } from './virtual-fs-uri-tracker';

export type { FileStatLike };

const MAX_CACHE_ENTRIES = 100;

export class JjViewFsService implements Disposable {
    private readonly _uriTracker: VirtualFsUriTracker;
    readonly onDidChangeFile: Event<Uri[]>;

    // Cache keyed by "base|filePath" → { left, right }
    private readonly _diffCache = new AsyncCache<string, { left: string; right: string }>({
        maxEntries: MAX_CACHE_ENTRIES,
    });
    private _cacheGeneration = 0;
    private _isDisposed = false;

    constructor(private readonly _repositoryManager: JjRepositoryManager) {
        this._uriTracker = new VirtualFsUriTracker(this._repositoryManager);
        this.onDidChangeFile = this._uriTracker.onDidChangeFile;
    }

    watch(uri: Uri): Disposable {
        if (this._isDisposed) {
            return { dispose: () => {} };
        }
        return this._uriTracker.watch(uri);
    }

    dispose(): void {
        this._isDisposed = true;
        void this._diffCache.clear();
        this._uriTracker.dispose();
    }

    /**
     * Clear the cache and return all known and watched URIs that were affected.
     */
    invalidateCache(): Uri[] {
        if (this._isDisposed) {
            return [];
        }
        this._cacheGeneration++;
        void this._diffCache.clear();
        return this._uriTracker.fireChangeEvents();
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
        const filePath = getFsPathFromUri(uri);
        const repo = this._repositoryManager.getRepositoryForUri(uri);
        if (!repo) {
            this._repositoryManager.outputChannel.info(
                `[JjViewFsService] No Jujutsu repository resolved for URI: ${uri.toString()} (scheme: ${uri.scheme}, fsPath: ${filePath})`,
            );
            throw new Error(`No Jujutsu repository found for: ${filePath}`);
        }
        this._uriTracker.recordAccess(uri);

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
        const content = await this._diffCache.getOrFetch(cacheKey, () => repo.jj.getDiffContent(base, filePath));
        const text = side === 'left' ? content.left : content.right;
        return Buffer.from(text, 'utf8');
    }
}
