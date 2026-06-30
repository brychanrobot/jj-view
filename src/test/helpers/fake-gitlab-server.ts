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
    source_project_id?: number;
}

export interface FakeGitLabNote {
    id: number;
    body: string;
    created_at: string;
    author: {
        name: string;
        username: string;
        avatar_url?: string;
    };
    resolved?: boolean;
    system?: boolean;
    position?: {
        new_path?: string;
        new_line?: number;
    };
}

export interface FakeGitLabDiscussion {
    id: string;
    notes?: FakeGitLabNote[];
}

export class FakeGitLabServer {
    private mrs = new Map<string, FakeMrInfo>();
    private discussions = new Map<number, FakeGitLabDiscussion[]>(); // mrIid -> FakeGitLabDiscussion[]
    private server: http.Server | undefined;
    public url = '';
    public requests: { url: string; method: string }[] = [];
    public statusOverride: { status: number; headers?: Record<string, string>; body?: string } | undefined;

    public registerMR(bookmark: string, mr: FakeMrInfo) {
        if (mr.source_project_id === undefined) {
            mr.source_project_id = 100;
        }
        this.mrs.set(bookmark, mr);
    }

    public registerDiscussions(mrIid: number, discussions: FakeGitLabDiscussion[]) {
        this.discussions.set(mrIid, discussions);
    }

    public clearRequests() {
        this.requests = [];
    }

    public async start(): Promise<string> {
        this.server = http.createServer((req, res) => {
            const urlStr = req.url || '';
            this.requests.push({ url: urlStr, method: req.method || 'GET' });

            if (this.statusOverride) {
                const headers = {
                    'Content-Type': 'application/json',
                    ...this.statusOverride.headers,
                };
                res.writeHead(this.statusOverride.status, headers);
                res.end(this.statusOverride.body || '');
                return;
            }

            const urlObj = new URL(urlStr, `http://${req.headers.host || 'localhost'}`);
            const pathname = urlObj.pathname;

            if (pathname.includes('/discussions')) {
                const mrMatch = pathname.match(/\/merge_requests\/(\d+)\/discussions/);
                if (mrMatch) {
                    const mrIid = parseInt(mrMatch[1], 10);
                    const list = this.discussions.get(mrIid) || [];

                    if (req.method === 'GET') {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(list));
                        return;
                    }
                }

                const noteMatch = pathname.match(/\/merge_requests\/(\d+)\/discussions\/([^/]+)\/notes$/);
                if (noteMatch && req.method === 'POST') {
                    const mrIid = parseInt(noteMatch[1], 10);
                    const discussionId = noteMatch[2];

                    let body = '';
                    req.on('data', (chunk: Buffer) => {
                        body += chunk.toString();
                    });
                    req.on('end', () => {
                        const parsed = JSON.parse(body) as { body: string };
                        const list = this.discussions.get(mrIid) || [];
                        const disc = list.find((d) => d.id === discussionId);

                        const newNote: FakeGitLabNote = {
                            id: Date.now(),
                            body: parsed.body,
                            created_at: new Date().toISOString(),
                            author: { name: 'Replier Name', username: 'replier_user' },
                        };

                        if (disc) {
                            disc.notes = disc.notes || [];
                            disc.notes.push(newNote);
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(newNote));
                    });
                    return;
                }

                const resolveMatch = pathname.match(/\/merge_requests\/(\d+)\/discussions\/([^/]+)$/);
                if (resolveMatch && req.method === 'PUT') {
                    const mrIid = parseInt(resolveMatch[1], 10);
                    const discussionId = resolveMatch[2];
                    const resolved = urlObj.searchParams.get('resolved') === 'true';

                    const list = this.discussions.get(mrIid) || [];
                    const disc = list.find((d) => d.id === discussionId);
                    if (disc?.notes) {
                        for (const n of disc.notes) {
                            n.resolved = resolved;
                        }
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ id: discussionId }));
                    return;
                }
            }

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

            if (pathname.includes('/projects/')) {
                if (!pathname.endsWith('/merge_requests') && !pathname.includes('/merge_requests/')) {
                    const projectPath = decodeURIComponent(
                        pathname.substring(pathname.indexOf('/projects/') + '/projects/'.length),
                    );
                    if (projectPath === 'fork-owner/fork-repo') {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(
                            JSON.stringify({
                                id: 200,
                                forked_from_project: {
                                    id: 100,
                                    path_with_namespace: 'mainline-owner/mainline-repo',
                                },
                            }),
                        );
                        return;
                    } else if (projectPath === 'mainline-owner/mainline-repo') {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(
                            JSON.stringify({
                                id: 100,
                            }),
                        );
                        return;
                    }
                }
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
