/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { JjViewFsService } from '../../jj-view-fs-service';
import type { Uri } from '../../uri-utils';

/**
 * Thin VS Code FileSystemProvider adapting JjViewFsService to the VS Code FileSystemProvider API.
 */
export class VsCodeViewFsProvider implements vscode.FileSystemProvider, vscode.Disposable {
    private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(public readonly service: JjViewFsService) {
        this._disposables.push(
            this.service.onDidChangeFile((uris) => {
                const events: vscode.FileChangeEvent[] = uris.map((uri) => ({
                    type: vscode.FileChangeType.Changed,
                    uri: uri as unknown as vscode.Uri,
                }));
                this._onDidChangeFile.fire(events);
            }),
        );
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
            throw vscode.FileSystemError.Unavailable(e instanceof Error ? e.message : String(e));
        }
    }

    writeFile(): void {
        throw vscode.FileSystemError.NoPermissions('jj-view is read-only');
    }

    readDirectory(): [string, vscode.FileType][] {
        return [];
    }

    createDirectory(): void {
        throw vscode.FileSystemError.NoPermissions('jj-view is read-only');
    }

    delete(): void {
        throw vscode.FileSystemError.NoPermissions('jj-view is read-only');
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions('jj-view is read-only');
    }

    dispose(): void {
        this._onDidChangeFile.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
