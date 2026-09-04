/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { type Event, EventEmitter } from './host/events';
import type { JjService } from './jj-service';
import { getUriParams, type Uri } from './uri-utils';

export class JjMergeService {
    private readonly _onDidChange = new EventEmitter<Uri>();
    readonly onDidChange: Event<Uri> = this._onDidChange.event;

    // Cache to avoid re-running jj resolve for same file
    private cache = new Map<string, { base: string; left: string; right: string }>();
    private inFlight = new Map<string, Promise<{ base: string; left: string; right: string }>>();

    constructor(private jjService: JjService) {}

    async provideContent(uri: Uri): Promise<string> {
        const query = getUriParams(uri);
        const rawPath = query.get('path');
        const part = query.get('part'); // 'base', 'left', 'right'

        if (!rawPath || !part) {
            console.error('JjMergeService: Missing path or part in URI');
            return '';
        }

        const fsPath = path.normalize(rawPath);

        try {
            // Check cache first
            let parts = this.cache.get(fsPath);
            if (!parts) {
                let promise = this.inFlight.get(fsPath);
                if (!promise) {
                    promise = this.jjService
                        .getConflictParts(fsPath)
                        .then((result) => {
                            if (this.inFlight.get(fsPath) === promise) {
                                this.cache.set(fsPath, result);
                                setTimeout(() => {
                                    if (this.cache.get(fsPath) === result) {
                                        this.cache.delete(fsPath);
                                    }
                                }, 5000);
                            }
                            return result;
                        })
                        .finally(() => {
                            if (this.inFlight.get(fsPath) === promise) {
                                this.inFlight.delete(fsPath);
                            }
                        });
                    this.inFlight.set(fsPath, promise);
                }
                parts = await promise;
            }

            if (part === 'base') {
                return parts.base;
            }
            if (part === 'left') {
                return parts.left;
            }
            if (part === 'right') {
                return parts.right;
            }

            throw new Error(`JjMergeService: Unknown merge part '${part}'`);
        } catch (e: unknown) {
            console.error(`JjMergeService: Failed to get conflict parts: ${e}`);
            throw e instanceof Error ? e : new Error(String(e));
        }
    }

    update(uri: Uri): void {
        const query = getUriParams(uri);
        const rawPath = query.get('path');
        if (rawPath) {
            this.clearCache(path.normalize(rawPath));
        }
        this._onDidChange.fire(uri);
    }

    clearCache(fsPath?: string): void {
        if (!fsPath) {
            this.cache.clear();
            this.inFlight.clear();
            return;
        }
        const normalized = path.normalize(fsPath);
        this.cache.delete(normalized);
        this.inFlight.delete(normalized);
    }
}
