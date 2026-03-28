/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import { JjService } from './jj-service';

/**
 * A FileSystemProvider that provides read-only access to "original" file content
 * for diff views and gutter decorations.
 *
 * Uses the jj-view scheme: jj-view:///path/to/file?base=<revision>&side=<left|right>
 */
export class JjViewFileSystemProvider implements vscode.FileSystemProvider {
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;

    // Cache keyed by "base|filePath" → { left, right }
    private _cache = new Map<string, { left: string; right: string }>();
    // Track all URIs that have been served so we can fire onDidChangeFile for them
    private _knownUris = new Set<string>();

    constructor(private jj: JjService) {}

    watch(): vscode.Disposable {
        // No-op: we fire change events manually during refresh
        return new vscode.Disposable(() => {});
    }

    /**
     * Clear the entire cache and notify VS Code that all known URIs have changed.
     * Firing FileChangeType.Changed for the "original" resource URIs is the
     * recommended way to force VS Code to refresh gutter indicators.
     */
    invalidateCache() {
        this._cache.clear();
        const events: vscode.FileChangeEvent[] = [];
        for (const uriStr of this._knownUris) {
            events.push({ type: vscode.FileChangeType.Changed, uri: vscode.Uri.parse(uriStr) });
        }
        this._knownUris.clear();
        if (events.length > 0) {
            const msg = `[JjViewFS] Invalidation firing for ${events.length} URIs: ${events.map((e) => e.uri.toString()).join(', ')}`;
            console.log(msg); // Direct stdout for CI logs
            this._onDidChangeFile.fire(events);
        }
    }

    async stat(_uri: vscode.Uri): Promise<vscode.FileStat> {
        return {
            type: vscode.FileType.File,
            ctime: 0,
            mtime: Date.now(),
            size: 0,
        };
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        this._knownUris.add(uri.toString());

        const query = new URLSearchParams(uri.query);
        const base = query.get('base');
        const side = query.get('side');

        if (!base || !side) {
            return new Uint8Array();
        }

        const filePath = uri.fsPath;
        const cacheKey = `${base}|${filePath}`;

        let content = this._cache.get(cacheKey);
        if (!content) {
            content = await this.jj.getDiffContent(base, filePath);
            this._cache.set(cacheKey, content);
        }

        const text = side === 'left' ? content.left : content.right;
        return Buffer.from(text, 'utf8');
    }

    writeFile(): void {
        throw vscode.FileSystemError.NoPermissions('jj-view is read-only');
    }

    delete(): void {
        throw vscode.FileSystemError.NoPermissions('jj-view is read-only');
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions('jj-view is read-only');
    }

    readDirectory(): [string, vscode.FileType][] {
        throw vscode.FileSystemError.NoPermissions('jj-view is file-only');
    }

    createDirectory(): void {
        throw vscode.FileSystemError.NoPermissions('jj-view is read-only');
    }
}
