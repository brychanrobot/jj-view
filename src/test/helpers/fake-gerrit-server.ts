/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as http from 'node:http';
import type { GerritChange } from '../../gerrit-provider';

export class FakeGerritServer {
    private changes = new Map<string, GerritChange>();
    private server: http.Server | undefined;
    public url = '';
    public requests: string[] = [];

    private nextChangeNumber = 1000;

    public addChange(change: Partial<GerritChange> & { change_id: string }) {
        const fullChange: GerritChange = {
            project: 'test-project',
            branch: 'main',
            subject: 'Test Change',
            status: 'NEW',
            submittable: false,
            created: '2023-01-01 12:00:00.000000000',
            updated: '2023-01-01 12:00:00.000000000',
            mergeable: true,
            insertions: 0,
            deletions: 0,
            _number: this.nextChangeNumber++,
            owner: { _account_id: 1 },
            ...change,
        };
        this.changes.set(change.change_id, fullChange);
        if (change._number !== undefined) {
            this.changes.set(String(change._number), fullChange);
        }
    }

    /**
     * Registers a change in the mock server.
     * @param changeId The I... Change-Id
     * @param parentSha Optional parent SHA to simulate mismatch
     * @returns The Gerrit change number
     */
    public registerChange(changeId: string, parentSha: string = 'remote-parent') {
        const num = this.nextChangeNumber++;
        const change: GerritChange = {
            project: 'test-project',
            branch: 'main',
            subject: 'Test Change',
            status: 'NEW',
            submittable: false,
            created: '2023-01-01 12:00:00.000000000',
            updated: '2023-01-01 12:00:00.000000000',
            mergeable: true,
            insertions: 0,
            deletions: 0,
            change_id: changeId,
            _number: num,
            current_revision: `sha-${num}`,
            revisions: {
                [`sha-${num}`]: {
                    commit: {
                        message: `Description\n\nChange-Id: ${changeId}`,
                        parents: [{ commit: parentSha }],
                    },
                    files: {},
                },
            },
            owner: { _account_id: 1 },
        };
        this.changes.set(changeId, change);
        this.changes.set(String(num), change);
        return num;
    }

    /**
     * Registers a change by its number (for Link: trailers).
     */
    public registerChangeByNumber(num: number, changeId: string = `I${num}000000000000000000000000000000000000000`) {
        const change: GerritChange = {
            project: 'test-project',
            branch: 'main',
            subject: 'Test Change',
            status: 'NEW',
            submittable: false,
            created: '2023-01-01 12:00:00.000000000',
            updated: '2023-01-01 12:00:00.000000000',
            mergeable: true,
            insertions: 0,
            deletions: 0,
            change_id: changeId,
            _number: num,
            current_revision: `sha-${num}`,
            revisions: {
                [`sha-${num}`]: {
                    commit: {
                        message: `Description\n\nChange-Id: ${changeId}`,
                        parents: [{ commit: 'remote-parent' }],
                    },
                    files: {},
                },
            },
            owner: { _account_id: 1 },
        };
        this.changes.set(String(num), change);
        this.changes.set(changeId, change);
        return num;
    }

    public updateChange(changeId: string, updates: Partial<GerritChange>) {
        const existing = this.changes.get(changeId);
        if (existing) {
            this.changes.set(changeId, { ...existing, ...updates });
        }
    }

    public clearRequests() {
        this.requests = [];
    }

    public async start(): Promise<string> {
        this.server = http.createServer((req, res) => {
            const urlStr = req.url || '';
            this.requests.push(urlStr);

            if (urlStr.includes('/config/server/version')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(')]}\' "3.7.0"');
                return;
            }

            if (urlStr.includes('/changes/')) {
                const urlObj = new URL(urlStr, `http://${req.headers.host}`);
                const queries = urlObj.searchParams.getAll('q');
                const options = new Set(urlObj.searchParams.getAll('o'));

                const allResults: Partial<GerritChange>[][] = [];
                for (const q of queries) {
                    const decodedQ = decodeURIComponent(q);
                    const keys = decodedQ.split(/\s+OR\s+/).map((k) => k.replace(/^change:/, ''));
                    const queryMatches: Partial<GerritChange>[] = [];

                    for (const key of keys) {
                        let change = this.changes.get(key);

                        if (!change) {
                            // Try searching by change number (_number)
                            const num = Number.parseInt(key, 10);
                            if (!Number.isNaN(num)) {
                                change = Array.from(this.changes.values()).find((c) => c._number === num);
                            }
                        }

                        if (change) {
                            // Clone and filter based on options
                            const filtered: Partial<GerritChange> = {
                                project: change.project,
                                branch: change.branch,
                                subject: change.subject,
                                status: change.status,
                                created: change.created,
                                updated: change.updated,
                                mergeable: change.mergeable,
                                _number: change._number,
                                change_id: change.change_id,
                                owner: change.owner,
                            };

                            if (options.has('SUBMITTABLE')) {
                                filtered.submittable = change.submittable;
                            }
                            if (options.has('LABELS')) {
                                filtered.labels = change.labels;
                            }
                            if (
                                options.has('CURRENT_REVISION') ||
                                options.has('ALL_REVISIONS') ||
                                options.has('CURRENT_FILES') ||
                                options.has('CURRENT_COMMIT')
                            ) {
                                filtered.current_revision = change.current_revision;
                                filtered.revisions = change.revisions;
                            }
                            // CURRENT_FILES and CURRENT_COMMIT are nested within revisions

                            queryMatches.push(filtered);
                        }
                    }
                    allResults.push(queryMatches);
                }

                // Gerrit returns a single array if only one q is provided,
                // but a nested array if multiple q are provided.
                const finalData = queries.length === 1 ? allResults[0] : allResults;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(`)]}'\n${JSON.stringify(finalData)}`);
                return;
            }

            res.writeHead(404);
            res.end('Not Found');
        });

        return new Promise((resolve) => {
            this.server?.listen(0, '127.0.0.1', () => {
                const address = this.server?.address();
                if (address && typeof address === 'object') {
                    this.url = `http://127.0.0.1:${address.port}`;
                }
                resolve(this.url);
            });
        });
    }

    public async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }
}
