/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { type JjEditFsService, parseEditUri } from '../../jj-edit-fs-service';
import type { JjRepository } from '../../jj-repository';
import type { Uri } from '../../uri-utils';
import { getErrorMessage } from '../../utils/error-utils';

export { parseEditUri };

/**
 * Thin VS Code FileSystemProvider adapting JjEditFsService to the VS Code FileSystemProvider API.
 */
export class VsCodeEditFsProvider implements vscode.FileSystemProvider, vscode.Disposable {
    private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(public readonly service: JjEditFsService) {
        this._disposables.push(
            this.service.onDidChangeFile((uris) => {
                const events: vscode.FileChangeEvent[] = uris.map((uri) => ({
                    type: vscode.FileChangeType.Changed,
                    uri: vscode.Uri.parse(uri.toString()),
                }));
                this._onDidChangeFile.fire(events);
            }),
        );
    }

    get onDidWrite(): ((repo: JjRepository) => void) | undefined {
        return this.service.onDidWrite;
    }

    set onDidWrite(handler: ((repo: JjRepository) => void) | undefined) {
        this.service.onDidWrite = handler;
    }

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    invalidateCache(): void {
        this.service.invalidateCache();
    }

    async stat(uri: Uri): Promise<vscode.FileStat> {
        const s = this.service.stat(uri);
        return {
            type: vscode.FileType.File,
            ctime: s.ctime,
            mtime: s.mtime,
            size: s.size,
        };
    }

    async readFile(uri: Uri): Promise<Uint8Array> {
        try {
            return await this.service.readFile(uri);
        } catch (e: unknown) {
            throw vscode.FileSystemError.Unavailable(getErrorMessage(e));
        }
    }

    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
        try {
            await this.service.writeFile(uri, content);
        } catch (e: unknown) {
            throw vscode.FileSystemError.Unavailable(getErrorMessage(e));
        }
    }

    readDirectory(): [string, vscode.FileType][] {
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

    dispose(): void {
        this.service.dispose();
        this._onDidChangeFile.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
