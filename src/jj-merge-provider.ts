// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as vscode from 'vscode';
import { JjService } from './jj-service';

/**
 * Content provider for merge editor inputs.
 * Provides base, left (ours), and right (theirs) content for conflicted files.
 */
export class JjMergeContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    // Cache to avoid re-running jj resolve for same file
    private cache = new Map<string, { base: string; left: string; right: string }>();

    constructor(private jjService: JjService) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const query = new URLSearchParams(uri.query);
        const fsPath = query.get('path');
        const part = query.get('part'); // 'base', 'left', 'right'

        if (!fsPath || !part) {
            console.error('JjMergeContentProvider: Missing path or part');
            return '';
        }

        try {
            // Check cache first
            let parts = this.cache.get(fsPath);
            if (!parts) {
                // Get conflict parts from jj resolve
                const relativePath = vscode.workspace.asRelativePath(fsPath);
                parts = await this.jjService.getConflictParts(relativePath);
                this.cache.set(fsPath, parts);

                // Clear cache after a short delay (file may change)
                setTimeout(() => this.cache.delete(fsPath), 5000);
            }

            if (part === 'base') {
                return parts.base;
            } else if (part === 'left') {
                return parts.left;
            } else if (part === 'right') {
                return parts.right;
            }

            return '';
        } catch (e) {
            console.error(`JjMergeContentProvider: Failed to get conflict parts: ${e}`);
            return `Error loading content: ${e}`;
        }
    }

    update(uri: vscode.Uri) {
        this._onDidChange.fire(uri);
    }

    clearCache(fsPath?: string) {
        if (fsPath) {
            this.cache.delete(fsPath);
        } else {
            this.cache.clear();
        }
    }
}
