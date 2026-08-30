/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';

import * as path from 'node:path';
import { type Disposable, type Event, EventEmitter } from './common/events';
import type { JjRepository } from './jj-repository';
import type { JjRepositoryManager } from './jj-repository-manager';
import { getFsPathFromUri, getUriParams, Uri } from './uri-utils';

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

export class JjEditFsService implements Disposable {
    private readonly _onDidChangeFile = new EventEmitter<Uri[]>();
    readonly onDidChangeFile: Event<Uri[]> = this._onDidChangeFile.event;

    private _pendingWrites = new Map<string, JjEditFsPendingWrite[]>();
    private _activeWrites = new Map<string, JjEditFsPendingWrite[]>();
    private _isFlushing = false;
    private _writeTimer: NodeJS.Timeout | undefined;
    private _knownUris = new Set<string>();

    constructor(
        private readonly _repositoryManager: JjRepositoryManager,
        public onDidWrite?: (repo: JjRepository) => void,
    ) {}

    dispose(): void {
        if (this._writeTimer) {
            clearTimeout(this._writeTimer);
            this._writeTimer = undefined;
        }
        for (const writes of this._pendingWrites.values()) {
            for (const write of writes) {
                write.reject(new Error('JjEditFsService disposed'));
            }
        }
        this._pendingWrites.clear();
        this._activeWrites.clear();
        this._knownUris.clear();
        this._onDidChangeFile.dispose();
    }

    invalidateCache(): Uri[] {
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

    stat(_uri: Uri): { type: number; ctime: number; mtime: number; size: number } {
        return {
            type: 1, // File
            ctime: 0,
            mtime: Date.now(),
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
            }, 100);
        });
    }

    private async _flushPendingWrites(): Promise<void> {
        if (this._isFlushing) {
            return;
        }
        this._isFlushing = true;
        if (this._writeTimer) {
            clearTimeout(this._writeTimer);
            this._writeTimer = undefined;
        }

        try {
            while (this._pendingWrites.size > 0) {
                const writesByRepo = new Map(this._pendingWrites);
                this._pendingWrites.clear();
                this._activeWrites = writesByRepo;

                for (const [repoKey, writes] of writesByRepo) {
                    try {
                        const repo = this._repositoryManager.getRepositoryForUri(Uri.file(repoKey));
                        if (!repo) {
                            for (const write of writes) {
                                write.reject(new Error(`Repository no longer available: ${repoKey}`));
                            }
                            continue;
                        }

                        // Group by revision within this repo
                        const writesByRevision = new Map<string, JjEditFsPendingWrite[]>();
                        for (const write of writes) {
                            const list = writesByRevision.get(write.revision) || [];
                            list.push(write);
                            writesByRevision.set(write.revision, list);
                        }

                        for (const [revision, revWrites] of writesByRevision) {
                            try {
                                const filesMap = new Map<string, string>();
                                for (const w of revWrites) {
                                    filesMap.set(w.filePath, w.content);
                                }

                                await repo.jj.setFilesContent(revision, filesMap);

                                this._onDidChangeFile.fire(revWrites.map((w) => w.uri));

                                for (const w of revWrites) {
                                    w.resolve();
                                }

                                if (this.onDidWrite) {
                                    this.onDidWrite(repo);
                                }
                            } catch (err: unknown) {
                                for (const w of revWrites) {
                                    w.reject(err);
                                }
                            }
                        }
                    } catch (repoErr: unknown) {
                        for (const write of writes) {
                            write.reject(repoErr);
                        }
                    }
                }
            }
        } finally {
            this._activeWrites.clear();
            this._isFlushing = false;
            if (this._pendingWrites.size > 0 && !this._writeTimer) {
                this._writeTimer = setTimeout(() => {
                    this._writeTimer = undefined;
                    this._flushPendingWrites();
                }, 100);
            }
        }
    }
}
