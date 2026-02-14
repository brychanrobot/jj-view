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

    // Cache keyed by "base|filePath" → { left, right }
    private _cache = new Map<string, { left: string; right: string }>();
    // Track all URIs that have been served so we can fire onDidChange for them
    private _knownUris = new Set<string>();

    constructor(private jj: JjService) {}

    /**
     * Clear the entire cache and notify VS Code that all known URIs have changed.
     * Called from refresh() to ensure stale content is never served.
     */
    invalidateCache() {
        this._cache.clear();
        for (const uriStr of this._knownUris) {
            this._onDidChange.fire(vscode.Uri.parse(uriStr));
        }
        this._knownUris.clear();
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

        // Track this URI for future invalidation
        this._knownUris.add(uri.toString());

        // Check cache first
        let content = this._cache.get(cacheKey);
        if (!content) {
            content = await this.jj.getDiffContent(base, filePath);
            this._cache.set(cacheKey, content);
        }

        return side === 'left' ? content.left : content.right;
    }
}
