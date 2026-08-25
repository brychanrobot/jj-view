/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Event, EventEmitter } from './common/events';
import type { JjRepositoryManager } from './jj-repository-manager';
import { decodeJjViewQuery, getFsPathFromUri, Uri } from './uri-utils';

export interface FileStatLike {
    type: number;
    ctime: number;
    mtime: number;
    size: number;
}

export class JjViewFsService {
    private readonly _onDidChangeFile = new EventEmitter<Uri[]>();
    readonly onDidChangeFile: Event<Uri[]> = this._onDidChangeFile.event;

    // Cache keyed by "base|filePath" → { left, right }
    private _cache = new Map<string, { left: string; right: string }>();
    // Track all URIs that have been served so we can notify when cache invalidates
    private _knownUris = new Set<string>();

    constructor(private readonly _repositoryManager: JjRepositoryManager) {}

    /**
     * Clear the cache and return all known URIs that were affected.
     */
    invalidateCache(): Uri[] {
        this._cache.clear();
        const changedUris: Uri[] = [];
        for (const uriStr of this._knownUris) {
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
            mtime: Date.now(),
            size: 0,
        };
    }

    async readFile(uri: Uri): Promise<Uint8Array> {
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
                try {
                    const content = await repo.jj.getFileContent(filePath, query.revision);
                    return Buffer.from(content, 'utf8');
                } catch {
                    return new Uint8Array();
                }
            }

            const cacheKey = `${query.base}|${filePath}`;

            let content = this._cache.get(cacheKey);
            if (!content) {
                content = await repo.jj.getDiffContent(query.base, filePath);
                this._cache.set(cacheKey, content);
            }

            const text = query.side === 'left' ? content.left : content.right;
            return Buffer.from(text, 'utf8');
        } catch {
            return new Uint8Array();
        }
    }
}
