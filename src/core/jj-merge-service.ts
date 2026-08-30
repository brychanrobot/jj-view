/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Event, EventEmitter } from './common/events';
import type { JjService } from './jj-service';
import { getUriParams, type Uri } from './uri-utils';

export class JjMergeService {
    private readonly _onDidChange = new EventEmitter<Uri>();
    readonly onDidChange: Event<Uri> = this._onDidChange.event;

    // Cache to avoid re-running jj resolve for same file
    private cache = new Map<string, { base: string; left: string; right: string }>();

    constructor(private jjService: JjService) {}

    async provideContent(uri: Uri): Promise<string> {
        const query = getUriParams(uri);
        const fsPath = query.get('path');
        const part = query.get('part'); // 'base', 'left', 'right'

        if (!fsPath || !part) {
            console.error('JjMergeService: Missing path or part');
            return '';
        }

        try {
            // Check cache first
            let parts = this.cache.get(fsPath);
            if (!parts) {
                // Get conflict parts from jj resolve
                parts = await this.jjService.getConflictParts(fsPath);
                this.cache.set(fsPath, parts);

                // Clear cache after a short delay (file may change)
                setTimeout(() => this.cache.delete(fsPath), 5000);
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

            return '';
        } catch (e: unknown) {
            console.error(`JjMergeService: Failed to get conflict parts: ${e}`);
            return `Error loading content: ${e}`;
        }
    }

    update(uri: Uri): void {
        this._onDidChange.fire(uri);
    }

    clearCache(fsPath?: string): void {
        if (fsPath) {
            this.cache.delete(fsPath);
        } else {
            this.cache.clear();
        }
    }
}
