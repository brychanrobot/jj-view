/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { JjMergeService } from '../../core/jj-merge-service';
import type { Uri } from '../../core/uri-utils';

/**
 * Thin VS Code TextDocumentContentProvider adapting JjMergeService to VS Code's merge editor input.
 */
export class VsCodeMergeContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChange.event;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(public readonly service: JjMergeService) {
        this._disposables.push(
            this.service.onDidChange((uri) => {
                this._onDidChange.fire(uri as unknown as vscode.Uri);
            }),
        );
    }

    async provideTextDocumentContent(uri: Uri): Promise<string> {
        return this.service.provideContent(uri);
    }

    update(uri: Uri): void {
        this.service.update(uri);
    }

    clearCache(fsPath?: string): void {
        this.service.clearCache(fsPath);
    }

    dispose(): void {
        this._onDidChange.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
