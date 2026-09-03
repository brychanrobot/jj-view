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
    source_branch?: string;
    target_branch?: string;
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
    private mrs = new Map<string, FakeMrInfo[]>();
    private discussions = new Map<number, FakeGitLabDiscussion[]>(); // mrIid -> FakeGitLabDiscussion[]
    private server: http.Server | undefined;
    public url = '';
    public requests: { url: string; method: string }[] = [];
    public statusOverride: { status: number; headers?: Record<string, string>; body?: string } | undefined;
    public defaultBranch = 'main';
    public createdMrs: Array<{
        source_branch: string;
        target_branch: string;
        title: string;
        description: string;
        iid: number;
    }> = [];
    public retargetedMrs: Array<{ iid: number; target_branch: string }> = [];

    public registerMR(bookmark: string, mr: FakeMrInfo) {
        if (mr.source_project_id === undefined) {
            mr.source_project_id = 100;
        }
        const list = this.mrs.get(bookmark) || [];
        list.push(mr);
        this.mrs.set(bookmark, list);
    }

    public registerDiscussions(mrIid: number, discussions: FakeGitLabDiscussion[]) {
        this.discussions.set(mrIid, discussions);
    }

    public clear() {
        this.requests = [];
        this.createdMrs = [];
        this.retargetedMrs = [];
        this.mrs.clear();
        this.discussions.clear();
        this.statusOverride = undefined;
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
                        let parsed: { body: string };
                        try {
                            parsed = JSON.parse(body) as { body: string };
                        } catch {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Invalid JSON' }));
                            return;
                        }
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
                if (req.method === 'POST' && pathname.endsWith('/merge_requests')) {
                    let body = '';
                    req.on('data', (chunk: Buffer) => {
                        body += chunk.toString();
                    });
                    req.on('end', () => {
                        let parsed: {
                            source_branch: string;
                            target_branch: string;
                            title: string;
                            description: string;
                        };
                        try {
                            parsed = JSON.parse(body) as {
                                source_branch: string;
                                target_branch: string;
                                title: string;
                                description: string;
                            };
                        } catch {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Invalid JSON' }));
                            return;
                        }
                        const totalMrs = Array.from(this.mrs.values()).reduce((sum, arr) => sum + arr.length, 0);
                        const iid = totalMrs + 10;
                        const newMr: FakeMrInfo = {
                            id: iid * 10,
                            iid,
                            state: 'opened',
                            title: parsed.title,
                            description: parsed.description,
                            web_url: `https://gitlab.com/test-group/test-project/-/merge_requests/${iid}`,
                            draft: false,
                            merge_status: 'can_be_merged',
                            detailed_merge_status: 'mergeable',
                            sha: 'abc1234',
                            source_branch: parsed.source_branch,
                            target_branch: parsed.target_branch,
                            source_project_id: 100,
                        };
                        this.createdMrs.push({ ...parsed, iid });
                        const list = this.mrs.get(parsed.source_branch) || [];
                        list.push(newMr);
                        this.mrs.set(parsed.source_branch, list);
                        res.writeHead(201, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(newMr));
                    });
                    return;
                }

                const putMrMatch = pathname.match(/\/merge_requests\/(\d+)$/);
                if (putMrMatch && req.method === 'PUT') {
                    const iid = parseInt(putMrMatch[1], 10);
                    let body = '';
                    req.on('data', (chunk: Buffer) => {
                        body += chunk.toString();
                    });
                    req.on('end', () => {
                        let parsed: { target_branch: string };
                        try {
                            parsed = JSON.parse(body) as { target_branch: string };
                        } catch {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Invalid JSON' }));
                            return;
                        }
                        this.retargetedMrs.push({ iid, target_branch: parsed.target_branch });
                        for (const mrList of this.mrs.values()) {
                            for (const mr of mrList) {
                                if (mr.iid === iid) {
                                    mr.target_branch = parsed.target_branch;
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify(mr));
                                    return;
                                }
                            }
                        }
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ message: '404 Not Found' }));
                    });
                    return;
                }

                const singleMrMatch = pathname.match(/\/merge_requests\/(\d+)$/);
                if (singleMrMatch && req.method === 'GET') {
                    const iid = parseInt(singleMrMatch[1], 10);
                    let foundMr: FakeMrInfo | undefined;
                    for (const mrList of this.mrs.values()) {
                        for (const mr of mrList) {
                            if (mr.iid === iid) {
                                foundMr = mr;
                                break;
                            }
                        }
                        if (foundMr) {
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
                const stateFilter = urlObj.searchParams.get('state');
                const results: FakeMrInfo[] = [];

                if (sourceBranch) {
                    const list = this.mrs.get(sourceBranch) || [];
                    for (const mr of list) {
                        if (!stateFilter || mr.state === stateFilter) {
                            results.push(mr);
                        }
                    }
                } else {
                    for (const list of this.mrs.values()) {
                        for (const mr of list) {
                            if (!stateFilter || mr.state === stateFilter) {
                                results.push(mr);
                            }
                        }
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
                                default_branch: this.defaultBranch,
                                forked_from_project: {
                                    id: 100,
                                    path_with_namespace: 'mainline-owner/mainline-repo',
                                },
                            }),
                        );
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            id: 100,
                            default_branch: this.defaultBranch,
                        }),
                    );
                    return;
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
                this.server.closeAllConnections?.();
                this.server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }
}
