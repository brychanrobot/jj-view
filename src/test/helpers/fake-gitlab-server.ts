/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'node:http';

export interface FakeMrInfo {
    id: number;
    iid: number;
    state: 'opened' | 'merged' | 'closed';
    title: string;
    description: string;
    web_url: string;
    draft: boolean;
    merge_status: 'can_be_merged' | 'cannot_be_merged';
    detailed_merge_status: 'mergeable' | 'conflict';
    blocking_discussions_resolved?: boolean;
    sha: string;
    user_notes_count?: number;
}

export class FakeGitLabServer {
    private mrs = new Map<string, FakeMrInfo>();
    private server: http.Server | undefined;
    public url = '';
    public requests: { url: string; method: string }[] = [];

    public registerMR(bookmark: string, mr: FakeMrInfo) {
        this.mrs.set(bookmark, mr);
    }

    public clearRequests() {
        this.requests = [];
    }

    public async start(): Promise<string> {
        this.server = http.createServer((req, res) => {
            const urlStr = req.url || '';
            this.requests.push({ url: urlStr, method: req.method || 'GET' });

            const urlObj = new URL(urlStr, `http://${req.headers.host || 'localhost'}`);
            const pathname = urlObj.pathname;

            if (pathname.includes('/merge_requests')) {
                const singleMrMatch = pathname.match(/\/merge_requests\/(\d+)$/);
                if (singleMrMatch) {
                    const iid = parseInt(singleMrMatch[1], 10);
                    let foundMr: FakeMrInfo | undefined;
                    for (const mr of this.mrs.values()) {
                        if (mr.iid === iid) {
                            foundMr = mr;
                            break;
                        }
                    }
                    if (foundMr) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(foundMr));
                    } else {
                        res.writeHead(404);
                        res.end('Not Found');
                    }
                    return;
                }

                const sourceBranch = urlObj.searchParams.get('source_branch');
                const results: FakeMrInfo[] = [];

                if (sourceBranch) {
                    const mr = this.mrs.get(sourceBranch);
                    if (mr) {
                        results.push(mr);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
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
