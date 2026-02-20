/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GerritChange } from '../gerrit-service';

export class FakeGerritServer {
    private changes = new Map<string, GerritChange>();

    public addChange(change: Partial<GerritChange> & { change_id: string }) {
        const fullChange: GerritChange = {
            project: 'test-project',
            branch: 'main',
            subject: 'Test Change',
            status: 'NEW',
            created: '2023-01-01 12:00:00.000000000',
            updated: '2023-01-01 12:00:00.000000000',
            mergeable: true,
            submittable: false,
            insertions: 0,
            deletions: 0,
            _number: 123,
            owner: { _account_id: 1 },
            ...change
        };
        this.changes.set(change.change_id, fullChange);
    }

    public updateChange(changeId: string, updates: Partial<GerritChange>) {
        const existing = this.changes.get(changeId);
        if (existing) {
            this.changes.set(changeId, { ...existing, ...updates });
        }
    }

    public handleFetch(url: string | URL | Request, _init?: RequestInit): Promise<Response> {
        const urlStr = url.toString();

        if (urlStr.includes('/config/server/version')) {
            return Promise.resolve(new Response(')]}\' "3.7.0"', { status: 200 }));
        }

        if (urlStr.includes('/changes/')) {
            // Check for specific change query by change_id
            const match = urlStr.match(/q=change:([^&]+)/);
            if (match) {
                const changeId = match[1];
                const change = this.changes.get(changeId);
                const changes = change ? [change] : [];
                return Promise.resolve(new Response(`)]}'\n${JSON.stringify(changes)}`, { status: 200 }));
            }
            
            // Check for commit SHA query
            const commitMatch = urlStr.match(/q=commit:([^&]+)/);
            if (commitMatch) {
                 return Promise.resolve(new Response(`)]}'\n[]`, { status: 200 }));
            }
        }

        return Promise.resolve(new Response('Not Found', { status: 404 }));
    }
}
