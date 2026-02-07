/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from './jj-service';

export class JjDocumentContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    get onDidChange(): vscode.Event<vscode.Uri> {
        return this._onDidChange.event;
    }

    constructor(private jj: JjService) {}

    update(uri: vscode.Uri) {
        this._onDidChange.fire(uri);
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        // expected uri format: jj-view:/absolute/path/to/file?revision=xyz
        // OR jj-view:/absolute/path/to/file (defaults to parent of working copy)

        const query = new URLSearchParams(uri.query);
        const revision = query.get('revision') || '@-';
        const explicitPath = query.get('path');
        
        // Prefer explicit path from query if available (handling renames robustly)
        // Otherwise fallback to fsPath
        const filePath = explicitPath || uri.fsPath;

        try {
            return await this.jj.cat(filePath, revision);
        } catch (e) {
            return ''; // Return empty if file not found (e.g. added file)
        }
    }
}
