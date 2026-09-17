/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Disposable, type Event, EventEmitter } from './host/events';
import type { JjRepositoryManager } from './jj-repository-manager';
import { Uri } from './uri-utils';

/**
 * Manages URI access tracking, reference-counted file watchers,
 * and change event emission for virtual filesystem providers.
 */
export class VirtualFsUriTracker implements Disposable {
    private readonly _onDidChangeFile = new EventEmitter<Uri[]>();
    readonly onDidChangeFile: Event<Uri[]> = this._onDidChangeFile.event;

    private readonly _knownUris = new Set<string>();
    private readonly _watchedUris = new Map<string, number>();
    private _isDisposed = false;

    constructor(private readonly _repositoryManager: JjRepositoryManager) {}

    recordAccess(uri: Uri): void {
        if (this._isDisposed) {
            return;
        }
        this._knownUris.add(uri.toString());
    }

    watch(uri: Uri): Disposable {
        if (this._isDisposed) {
            return { dispose: () => {} };
        }
        const key = uri.toString();
        this._watchedUris.set(key, (this._watchedUris.get(key) || 0) + 1);
        let isDisposed = false;
        return {
            dispose: () => {
                if (isDisposed) {
                    return;
                }
                isDisposed = true;
                this._decrementWatcher(key);
            },
        };
    }

    private _decrementWatcher(key: string): void {
        if (this._isDisposed) {
            return;
        }
        const count = (this._watchedUris.get(key) || 0) - 1;
        if (count <= 0) {
            this._watchedUris.delete(key);
            return;
        }
        this._watchedUris.set(key, count);
    }

    fireChangeEvents(extraUris: readonly Uri[] = []): Uri[] {
        if (this._isDisposed) {
            return [];
        }
        const urisToNotify = new Set<string>([
            ...this._knownUris,
            ...this._watchedUris.keys(),
            ...extraUris.map((u) => u.toString()),
        ]);
        this._knownUris.clear();

        const changedUris: Uri[] = [];
        for (const uriStr of urisToNotify) {
            try {
                const uri = Uri.parse(uriStr);
                if (this._repositoryManager.getRepositoryForUri(uri)) {
                    changedUris.push(uri);
                }
            } catch {
                // Ignore malformed URIs
            }
        }
        if (changedUris.length > 0) {
            this._onDidChangeFile.fire(changedUris);
        }
        return changedUris;
    }

    fireDirectChangeEvents(uris: readonly Uri[]): void {
        if (this._isDisposed || uris.length === 0) {
            return;
        }
        const seen = new Set<string>();
        const dedupedUris: Uri[] = [];
        for (const uri of uris) {
            const key = uri.toString();
            if (!seen.has(key)) {
                seen.add(key);
                dedupedUris.push(uri);
            }
        }
        if (dedupedUris.length > 0) {
            this._onDidChangeFile.fire(dedupedUris);
        }
    }

    dispose(): void {
        this._isDisposed = true;
        this._knownUris.clear();
        this._watchedUris.clear();
        this._onDidChangeFile.dispose();
    }
}
