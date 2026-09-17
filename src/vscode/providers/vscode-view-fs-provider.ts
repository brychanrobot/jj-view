/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { JjViewFsService } from '../../core/jj-view-fs-service';
import { Uri } from '../../core/uri-utils';
import { getErrorMessage } from '../../utils/error-utils';

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
                this._onDidChangeFile.fire(
                    uris.map((uri) => ({
                        type: vscode.FileChangeType.Changed,
                        uri: vscode.Uri.parse(uri.toString()),
                    })),
                );
            }),
        );
    }

    watch(
        uri: vscode.Uri,
        _options?: { readonly recursive: boolean; readonly excludes: readonly string[] },
    ): vscode.Disposable {
        const disposable = this.service.watch(Uri.parse(uri.toString()));
        return new vscode.Disposable(() => disposable.dispose());
    }

    invalidateCache(): void {
        this.service.invalidateCache();
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const s = this.service.stat(Uri.parse(uri.toString()));
        return {
            type: vscode.FileType.File,
            ctime: s.ctime,
            mtime: s.mtime,
            size: s.size,
            permissions: vscode.FilePermission.Readonly,
        };
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        try {
            return await this.service.readFile(Uri.parse(uri.toString()));
        } catch (e: unknown) {
            throw vscode.FileSystemError.Unavailable(getErrorMessage(e));
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
        this.service.dispose();
        this._onDidChangeFile.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
    }
}
