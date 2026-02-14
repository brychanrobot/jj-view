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
        } catch {
            // For merge commits, `revision-` resolves to multiple commits and
            // fails. Fall back to trying each parent individually (analogous to
            // git's "diff against first parent" convention).
            if (revision.endsWith('-')) {
                const baseRevision = revision.slice(0, -1);
                try {
                    const entries = await this.jj.getLog({ revision: `parents(${baseRevision})` });
                    for (const entry of entries) {
                        try {
                            return await this.jj.cat(filePath, entry.commit_id);
                        } catch {
                            continue;
                        }
                    }
                } catch {
                    // Failed to resolve parents
                }
            }
            return ''; // File doesn't exist in any parent (truly new file)
        }
    }
}

