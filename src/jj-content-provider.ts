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

    // Cache keyed by repoRoot → Map("base|filePath" → { left, right })
    private _cache = new Map<string, Map<string, { left: string; right: string }>>();
    // Track all URIs keyed by repoRoot → Set(uriStr)
    private _knownUris = new Map<string, Set<string>>();

    constructor(private getJjService: (uri: vscode.Uri) => JjService | undefined) {}

    /**
     * Clear the entire cache and notify VS Code that all known URIs have changed.
     * Called from refresh() to ensure stale content is never served.
     */
    invalidateCache(repoRoot?: string) {
        if (repoRoot) {
            // Clear cache for this repo
            this._cache.get(repoRoot)?.clear();

            // Notify for this repo
            const uris = this._knownUris.get(repoRoot);
            if (uris) {
                for (const uriStr of uris) {
                    this._onDidChange.fire(vscode.Uri.parse(uriStr));
                }
                uris.clear();
            }
        } else {
            this._cache.clear();
            for (const repoUris of this._knownUris.values()) {
                for (const uriStr of repoUris) {
                    this._onDidChange.fire(vscode.Uri.parse(uriStr));
                }
            }
            this._knownUris.clear();
        }
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const query = new URLSearchParams(uri.query);
        const base = query.get('base');
        const side = query.get('side');
        const explicitPath = query.get('path');

        if (!base || !side) {
            return '';
        }

        const filePath = explicitPath || uri.fsPath;
        const cacheKey = `${base}|${filePath}`;

        const jj = this.getJjService(uri);
        if (!jj) {
            return '';
        }

        const repoRoot = jj.repoRoot;

        // Track this URI for future invalidation
        let repoUris = this._knownUris.get(repoRoot);
        if (!repoUris) {
            repoUris = new Set();
            this._knownUris.set(repoRoot, repoUris);
        }
        repoUris.add(uri.toString());

        // Check cache first
        let repoCache = this._cache.get(repoRoot);
        if (!repoCache) {
            repoCache = new Map();
            this._cache.set(repoRoot, repoCache);
        }

        let content = repoCache.get(cacheKey);
        if (!content) {
            content = await jj.getDiffContent(base, filePath);
            repoCache.set(cacheKey, content);
        }

        return side === 'left' ? content.left : content.right;
    }
}
