/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { getFsPathFromUri } from './uri-utils';

/**
 * Parse a jj-edit URI to extract revision and file path.
 * URI format: jj-edit:///relative/path#root=<repoRoot>&revision=<changeId>
 */
function parseEditUri(uri: vscode.Uri): { revision: string; filePath: string } {
    const params = new URLSearchParams(uri.fragment);
    const revision = params.get('revision');
    if (!revision) {
        throw vscode.FileSystemError.Unavailable('Missing revision in jj-edit URI');
    }
    const filePath = getFsPathFromUri(uri);
    return { revision, filePath };
}

/**
 * A FileSystemProvider that enables editing files in non-working-copy revisions.
 *
 * Read: fetches content via `jj file show -r <revision>`.
 * Write: applies content via `jj diffedit --tool` to modify the revision in-place.
 */
export class JjEditFileSystemProvider implements vscode.FileSystemProvider {
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;

    private _pendingWrites = new Map<
        string,
        {
            revision: string;
            filePath: string;
            content: string;
            uri: vscode.Uri;
            resolve: () => void;
            reject: (err: unknown) => void;
        }[]
    >();
    private _writeTimer: NodeJS.Timeout | undefined;
    private _knownUris = new Set<string>();

    constructor(
        private readonly _repositoryManager: import('./jj-repository-manager').JjRepositoryManager,
        public onDidWrite?: (repo: import('./jj-repository').JjRepository) => void,
    ) {}

    watch(): vscode.Disposable {
        // No-op: we fire change events manually after writes or refresh
        return new vscode.Disposable(() => {});
    }

    /**
     * Notify VS Code that all known URIs have changed.
     * Called during SCM refresh to ensure open diff editors show up-to-date content.
     */
    invalidateCache() {
        const events: vscode.FileChangeEvent[] = [];
        for (const uriStr of this._knownUris) {
            const uri = vscode.Uri.parse(uriStr);
            if (this._repositoryManager.getRepositoryForUri(uri)) {
                events.push({ type: vscode.FileChangeType.Changed, uri });
            }
        }
        this._knownUris.clear();
        if (events.length > 0) {
            this._onDidChangeFile.fire(events);
        }
    }

    async stat(_uri: vscode.Uri): Promise<vscode.FileStat> {
        // Return a default stat. The provider is only used for files we know exist
        // in the revision (they were listed by jj diff). Avoid calling jj here
        // to prevent race conditions and unnecessary overhead.
        return {
            type: vscode.FileType.File,
            ctime: 0,
            mtime: Date.now(),
            size: 0,
        };
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        this._knownUris.add(uri.toString());
        const { revision, filePath } = parseEditUri(uri);
        const repo = this._repositoryManager.getRepositoryForUri(uri);
        if (!repo) {
            this._repositoryManager.outputChannel.info(
                `[JjEditFileSystemProvider] No Jujutsu repository resolved for URI: ${uri.toString()} (scheme: ${uri.scheme}, fsPath: ${filePath})`,
            );
            throw vscode.FileSystemError.Unavailable(`No Jujutsu repository found for: ${filePath}`);
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

    async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        const { revision, filePath } = parseEditUri(uri);
        const repo = this._repositoryManager.getRepositoryForUri(uri);
        if (!repo) {
            this._repositoryManager.outputChannel.info(
                `[JjEditFileSystemProvider] No Jujutsu repository resolved for URI: ${uri.toString()} (scheme: ${uri.scheme}, fsPath: ${filePath})`,
            );
            throw vscode.FileSystemError.Unavailable(`No Jujutsu repository found for: ${filePath}`);
        }
        const text = Buffer.from(content).toString('utf8');
        const repoRoot = repo.rootUri.fsPath;
        const batchKey = `${repoRoot}\u0000${revision}`;

        return new Promise<void>((resolve, reject) => {
            const pending = this._pendingWrites.get(batchKey) || [];
            pending.push({ revision, filePath, content: text, uri, resolve, reject });
            this._pendingWrites.set(batchKey, pending);

            if (this._writeTimer) {
                clearTimeout(this._writeTimer);
            }

            this._writeTimer = setTimeout(() => this.flushWrites(), 100);
        });
    }

    private async flushWrites() {
        const batches = Array.from(this._pendingWrites.entries());
        this._pendingWrites.clear();

        for (const [batchKey, requests] of batches) {
            const separatorIndex = batchKey.indexOf('\u0000');
            const repoRoot = batchKey.substring(0, separatorIndex);
            const revision = batchKey.substring(separatorIndex + 1);
            const repo = repoRoot ? this._repositoryManager.getRepositoryForUri(vscode.Uri.file(repoRoot)) : undefined;
            if (!repo) {
                this._repositoryManager.outputChannel.info(
                    `[JjEditFileSystemProvider.flushWrites] No Jujutsu repository resolved for root: ${repoRoot}`,
                );
                const err = new Error(`No Jujutsu repository found for root: ${repoRoot}`);
                for (const req of requests) {
                    req.reject(err);
                }
                continue;
            }

            try {
                const filesMap = new Map<string, string>();
                for (const req of requests) {
                    filesMap.set(req.filePath, req.content);
                }

                if (revision === '@') {
                    for (const [filePath, contentStr] of filesMap.entries()) {
                        await fs.writeFile(filePath, contentStr);
                    }
                } else {
                    await repo.jj.setFilesContent(revision, filesMap);
                }

                // Notify VS Code and resolve all promises
                const changeEvents: vscode.FileChangeEvent[] = [];
                for (const req of requests) {
                    changeEvents.push({ type: vscode.FileChangeType.Changed, uri: req.uri });
                    req.resolve();
                }
                this._onDidChangeFile.fire(changeEvents);

                // Trigger SCM refresh once per batch
                if (repo) {
                    this.onDidWrite?.(repo);
                }
            } catch (err) {
                // Reject all promises in the batch if it fails
                for (const req of requests) {
                    req.reject(err);
                }
            }
        }
    }

    readDirectory(): Thenable<[string, vscode.FileType][]> {
        throw vscode.FileSystemError.NoPermissions('jj-edit is file-only');
    }

    createDirectory(): void {
        throw vscode.FileSystemError.NoPermissions('jj-edit is file-only');
    }

    delete(): void {
        throw vscode.FileSystemError.NoPermissions('jj-edit does not support delete');
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions('jj-edit does not support rename');
    }
}
