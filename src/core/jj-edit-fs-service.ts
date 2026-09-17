/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';

import * as path from 'node:path';
import { type Disposable, type Event, EventEmitter } from './host/events';
import type { JjRepository } from './jj-repository';
import type { JjRepositoryManager } from './jj-repository-manager';
import { type FileStatLike, getFsPathFromUri, getUriParams, Uri } from './uri-utils';

export interface JjEditFsPendingWrite {
    revision: string;
    filePath: string;
    content: string;
    uri: Uri;
    resolve: () => void;
    reject: (err: unknown) => void;
}

export function parseEditUri(uri: Uri): { revision: string; filePath: string } {
    const params = getUriParams(uri);
    const revision = params.get('revision');
    if (!revision) {
        throw new Error('Missing revision in jj-edit URI');
    }
    const filePath = getFsPathFromUri(uri);
    return { revision, filePath };
}

const WRITE_FLUSH_DEBOUNCE_MS = 100;

export class JjEditFsService implements Disposable {
    private readonly _onDidChangeFile = new EventEmitter<Uri[]>();
    readonly onDidChangeFile: Event<Uri[]> = this._onDidChangeFile.event;

    private _pendingWrites = new Map<string, JjEditFsPendingWrite[]>();
    private _activeWrites = new Map<string, JjEditFsPendingWrite[]>();
    private _isFlushing = false;
    private _writeTimer: NodeJS.Timeout | undefined;
    private _knownUris = new Set<string>();
    private readonly _watchedUris = new Map<string, number>();
    private _writeVersion = 0;
    private _isDisposed = false;

    constructor(
        private readonly _repositoryManager: JjRepositoryManager,
        public onDidWrite?: (repo: JjRepository) => void,
    ) {}

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
        if (this._writeTimer) {
            clearTimeout(this._writeTimer);
            this._writeTimer = undefined;
        }
        for (const writes of this._pendingWrites.values()) {
            for (const write of writes) {
                write.reject(new Error('JjEditFsService disposed'));
            }
        }
        for (const writes of this._activeWrites.values()) {
            for (const write of writes) {
                write.reject(new Error('JjEditFsService disposed'));
            }
        }
        this._pendingWrites.clear();
        this._activeWrites.clear();
        this._knownUris.clear();
        this._watchedUris.clear();
        this.onDidWrite = undefined;
        this._onDidChangeFile.dispose();
    }

    invalidateCache(): Uri[] {
        if (this._isDisposed) {
            return [];
        }
        this._writeVersion++;
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
            mtime: 1700000000000 + this._writeVersion,
            size: 0,
        };
    }

    private getPendingOrActiveContent(repoKey: string, revision: string, filePath: string): string | undefined {
        const normalizedPath = path.normalize(filePath);
        const isMatch = (w: JjEditFsPendingWrite) =>
            w.revision === revision && path.normalize(w.filePath) === normalizedPath;

        const pending = this._pendingWrites.get(repoKey)?.findLast(isMatch);
        if (pending) {
            return pending.content;
        }

        const active = this._activeWrites.get(repoKey)?.findLast(isMatch);
        return active?.content;
    }

    async readFile(uri: Uri): Promise<Uint8Array> {
        if (this._isDisposed) {
            throw new Error('JjEditFsService is disposed');
        }
        this._knownUris.add(uri.toString());
        const { revision, filePath } = parseEditUri(uri);
        const repo = this._repositoryManager.getRepositoryForUri(uri);
        if (!repo) {
            this._repositoryManager.outputChannel.info(
                `[JjEditFsService] No Jujutsu repository resolved for URI: ${uri.toString()} (scheme: ${uri.scheme}, fsPath: ${filePath})`,
            );
            throw new Error(`No Jujutsu repository found for: ${filePath}`);
        }

        const repoKey = repo.rootUri.fsPath;
        const inMemoryContent = this.getPendingOrActiveContent(repoKey, revision, filePath);
        if (inMemoryContent !== undefined) {
            return Buffer.from(inMemoryContent, 'utf8');
        }

        if (revision === '@') {
            try {
                return await fs.readFile(filePath);
            } catch {
                // Fallback to jj file show if disk file is missing/unreadable
            }
        }

        const content = await repo.jj.getFileContent(filePath, revision);
        return Buffer.from(content, 'utf8');
    }

    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
        if (this._isDisposed) {
            throw new Error('JjEditFsService is disposed');
        }
        const { revision, filePath } = parseEditUri(uri);
        const repo = this._repositoryManager.getRepositoryForUri(uri);
        if (!repo) {
            this._repositoryManager.outputChannel.info(
                `[JjEditFsService] No Jujutsu repository resolved for write: ${uri.toString()} (scheme: ${uri.scheme}, fsPath: ${filePath})`,
            );
            throw new Error(`No Jujutsu repository found for: ${filePath}`);
        }

        const repoKey = repo.rootUri.fsPath;
        const stringContent = Buffer.from(content).toString('utf8');

        return new Promise<void>((resolve, reject) => {
            const pendingList = this._pendingWrites.get(repoKey) || [];
            pendingList.push({
                revision,
                filePath,
                content: stringContent,
                uri,
                resolve,
                reject,
            });
            this._pendingWrites.set(repoKey, pendingList);

            if (this._writeTimer) {
                clearTimeout(this._writeTimer);
            }
            this._writeTimer = setTimeout(() => {
                this._writeTimer = undefined;
                this._flushPendingWrites();
            }, WRITE_FLUSH_DEBOUNCE_MS);
        });
    }

    private async _flushRevisionWrites(
        repo: JjRepository,
        revision: string,
        revWrites: JjEditFsPendingWrite[],
    ): Promise<void> {
        try {
            const filesMap = new Map<string, string>();
            for (const w of revWrites) {
                filesMap.set(w.filePath, w.content);
            }

            await repo.jj.setFilesContent(revision, filesMap);
            this._writeVersion++;
            if (!this._isDisposed) {
                this._onDidChangeFile.fire(revWrites.map((w) => w.uri));
            }

            for (const w of revWrites) {
                w.resolve();
            }

            if (this.onDidWrite) {
                try {
                    this.onDidWrite(repo);
                } catch (err: unknown) {
                    this._repositoryManager.outputChannel.error(
                        `[JjEditFsService] onDidWrite callback failed: ${String(err)}`,
                    );
                }
            }
        } catch (err: unknown) {
            for (const w of revWrites) {
                w.reject(err);
            }
        }
    }

    private _groupWritesByRevision(writes: JjEditFsPendingWrite[]): Map<string, JjEditFsPendingWrite[]> {
        const writesByRevision = new Map<string, JjEditFsPendingWrite[]>();
        for (const write of writes) {
            const list = writesByRevision.get(write.revision) || [];
            list.push(write);
            writesByRevision.set(write.revision, list);
        }
        return writesByRevision;
    }

    private async _flushRepoWrites(repoKey: string, writes: JjEditFsPendingWrite[]): Promise<void> {
        if (this._isDisposed) {
            for (const write of writes) {
                write.reject(new Error('JjEditFsService disposed'));
            }
            this._activeWrites.delete(repoKey);
            return;
        }

        try {
            const repo = this._repositoryManager.getRepositoryForUri(Uri.file(repoKey));
            if (!repo) {
                for (const write of writes) {
                    write.reject(new Error(`Repository no longer available: ${repoKey}`));
                }
                return;
            }

            const writesByRevision = this._groupWritesByRevision(writes);
            for (const [revision, revWrites] of writesByRevision) {
                await this._flushSingleRevision(repo, repoKey, revision, revWrites);
            }
        } catch (repoErr: unknown) {
            for (const write of writes) {
                write.reject(repoErr);
            }
        } finally {
            this._activeWrites.delete(repoKey);
        }
    }

    private async _flushSingleRevision(
        repo: JjRepository,
        repoKey: string,
        revision: string,
        revWrites: JjEditFsPendingWrite[],
    ): Promise<void> {
        if (this._isDisposed) {
            for (const w of revWrites) {
                w.reject(new Error('JjEditFsService disposed'));
            }
            return;
        }

        try {
            await this._flushRevisionWrites(repo, revision, revWrites);
        } finally {
            this._pruneActiveWrites(repoKey, revWrites);
        }
    }

    private _pruneActiveWrites(repoKey: string, completedWrites: JjEditFsPendingWrite[]): void {
        const activeList = this._activeWrites.get(repoKey);
        if (!activeList) {
            return;
        }
        const remaining = activeList.filter((w) => !completedWrites.includes(w));
        if (remaining.length > 0) {
            this._activeWrites.set(repoKey, remaining);
            return;
        }
        this._activeWrites.delete(repoKey);
    }

    private _schedulePendingWriteFlush(): void {
        if (this._isDisposed || this._pendingWrites.size === 0 || this._writeTimer) {
            return;
        }
        this._writeTimer = setTimeout(() => {
            this._writeTimer = undefined;
            this._flushPendingWrites();
        }, WRITE_FLUSH_DEBOUNCE_MS);
    }

    private async _flushPendingWrites(): Promise<void> {
        if (this._isFlushing || this._isDisposed) {
            return;
        }
        this._isFlushing = true;
        if (this._writeTimer) {
            clearTimeout(this._writeTimer);
            this._writeTimer = undefined;
        }

        try {
            if (this._pendingWrites.size === 0 || this._isDisposed) {
                return;
            }
            const writesByRepo = new Map(this._pendingWrites);
            this._pendingWrites.clear();
            this._activeWrites = writesByRepo;

            for (const [repoKey, writes] of writesByRepo) {
                if (this._isDisposed) {
                    break;
                }
                await this._flushRepoWrites(repoKey, writes);
            }
        } finally {
            this._activeWrites.clear();
            this._isFlushing = false;
            this._schedulePendingWriteFlush();
        }
    }
}
