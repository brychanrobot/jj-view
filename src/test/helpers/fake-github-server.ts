/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'node:http';

export interface FakePrInfo {
    id: string;
    number: number;
    state: 'OPEN' | 'MERGED' | 'CLOSED';
    mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
    url: string;
    currentRevision?: string;
    remoteParents?: string[];
    unresolvedComments?: number;
    headOwner?: string;
}

export interface FakeComment {
    id: string;
    body: string;
    createdAt: string;
    author: {
        login: string;
        avatarUrl?: string;
    };
}

export interface FakeReviewThread {
    id: string;
    isResolved: boolean;
    path: string;
    line?: number | null;
    comments: FakeComment[];
}

interface GqlPrNode {
    id: string;
    number: number;
    state: string;
    mergeable: string;
    url: string;
    headRepository?: {
        owner?: {
            login?: string;
        };
    };
    reviewThreads?: {
        nodes?: {
            isResolved: boolean;
        }[];
    };
    commits?: {
        nodes?: {
            commit?: {
                oid: string;
                message: string;
                parents?: {
                    nodes?: {
                        oid: string;
                    }[];
                };
            };
        }[];
    };
}

export class FakeGitHubServer {
    private prs = new Map<string, FakePrInfo>();
    private threads = new Map<string, FakeReviewThread[]>(); // prId -> FakeReviewThread[]
    private server: http.Server | undefined;
    public url = '';
    public requests: { url: string; body: string }[] = [];

    public registerPR(bookmark: string, pr: FakePrInfo) {
        this.prs.set(bookmark, pr);
    }

    public registerReviewThreads(prId: string, threads: FakeReviewThread[]) {
        this.threads.set(prId, threads);
    }

    public clearRequests() {
        this.requests = [];
    }

    public async start(): Promise<string> {
        this.server = http.createServer((req, res) => {
            const urlStr = req.url || '';

            if (req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => {
                    body += chunk.toString();
                });
                req.on('end', () => {
                    this.requests.push({ url: urlStr, body });

                    try {
                        const parsedBody = JSON.parse(body) as { query?: string; variables?: Record<string, unknown> };
                        const query = parsedBody.query || '';

                        if (query.includes('node(id:') || query.includes('$id: ID!')) {
                            const variables = parsedBody.variables as { id: string } | undefined;
                            const prId = variables?.id || '';
                            const prThreads = this.threads.get(prId) || [];

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(
                                JSON.stringify({
                                    data: {
                                        node: {
                                            reviewThreads: {
                                                nodes: prThreads.map((t) => ({
                                                    id: t.id,
                                                    isResolved: t.isResolved,
                                                    path: t.path,
                                                    line: t.line,
                                                    comments: {
                                                        nodes: t.comments,
                                                    },
                                                })),
                                            },
                                        },
                                    },
                                }),
                            );
                            return;
                        }

                        if (query.includes('addPullRequestReviewThreadReply')) {
                            const variables = parsedBody.variables as { threadId: string; body: string } | undefined;
                            const threadId = variables?.threadId || '';
                            const bodyText = variables?.body || '';

                            let createdComment: FakeComment | undefined;
                            let targetThread: FakeReviewThread | undefined;
                            for (const threadsList of this.threads.values()) {
                                const found = threadsList.find((t) => t.id === threadId);
                                if (found) {
                                    targetThread = found;
                                    createdComment = {
                                        id: `comment-reply-${Date.now()}`,
                                        body: bodyText,
                                        createdAt: new Date().toISOString(),
                                        author: { login: 'replier-login' },
                                    };
                                    found.comments.push(createdComment);
                                    break;
                                }
                            }

                            // Handle batched resolution mutation if present in the same query
                            const isResolve = query.includes('resolveReviewThread');
                            const isUnresolve = query.includes('unresolveReviewThread');
                            if (targetThread && (isResolve || isUnresolve)) {
                                targetThread.isResolved = isResolve;
                            }

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(
                                JSON.stringify({
                                    data: {
                                        addPullRequestReviewThreadReply: {
                                            comment: createdComment,
                                        },
                                        ...(isResolve || isUnresolve
                                            ? {
                                                  resolveReviewThread: {
                                                      thread: {
                                                          id: threadId,
                                                          isResolved: isResolve,
                                                      },
                                                  },
                                                  unresolveReviewThread: {
                                                      thread: {
                                                          id: threadId,
                                                          isResolved: isResolve,
                                                      },
                                                  },
                                              }
                                            : {}),
                                    },
                                }),
                            );
                            return;
                        }

                        if (query.includes('resolveReviewThread') || query.includes('unresolveReviewThread')) {
                            const variables = parsedBody.variables as { threadId: string } | undefined;
                            const threadId = variables?.threadId || '';
                            const resolve =
                                query.includes('resolveReviewThread') && !query.includes('unresolveReviewThread');

                            for (const threadsList of this.threads.values()) {
                                const found = threadsList.find((t) => t.id === threadId);
                                if (found) {
                                    found.isResolved = resolve;
                                    break;
                                }
                            }

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(
                                JSON.stringify({
                                    data: {
                                        resolvePullRequestReviewThread: {
                                            thread: {
                                                id: threadId,
                                                isResolved: resolve,
                                            },
                                        },
                                    },
                                }),
                            );
                            return;
                        }

                        // Parse queries in the format:
                        // pr_0: pullRequests(first: 1, headRefName: "some-bookmark") {
                        const regex = /(\w+):\s*pullRequests\s*\([^)]*headRefName:\s*"([^"]+)"[^)]*\)/g;
                        let match = regex.exec(query);
                        const repositoryData: Record<string, { nodes: GqlPrNode[] } | null> = {};

                        while (match !== null) {
                            const alias = match[1];
                            const bookmarkName = match[2];

                            const pr = this.prs.get(bookmarkName);
                            if (pr) {
                                const prNode: GqlPrNode = {
                                    id: pr.id,
                                    number: pr.number,
                                    state: pr.state,
                                    mergeable: pr.mergeable,
                                    url: pr.url,
                                    headRepository: {
                                        owner: {
                                            login: pr.headOwner || 'test-owner',
                                        },
                                    },
                                };

                                if (pr.unresolvedComments !== undefined) {
                                    const nodes = [];
                                    for (let i = 0; i < pr.unresolvedComments; i++) {
                                        nodes.push({ isResolved: false });
                                    }
                                    prNode.reviewThreads = { nodes };
                                }

                                if (pr.currentRevision) {
                                    const parentNodes = pr.remoteParents
                                        ? pr.remoteParents.map((oid) => ({ oid }))
                                        : [];
                                    prNode.commits = {
                                        nodes: [
                                            {
                                                commit: {
                                                    oid: pr.currentRevision,
                                                    message: 'Mock PR Commit Description',
                                                    parents: {
                                                        nodes: parentNodes,
                                                    },
                                                },
                                            },
                                        ],
                                    };
                                }

                                repositoryData[alias] = {
                                    nodes: [prNode],
                                };
                            } else {
                                repositoryData[alias] = {
                                    nodes: [],
                                };
                            }

                            match = regex.exec(query);
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(
                            JSON.stringify({
                                data: {
                                    repository: repositoryData,
                                },
                            }),
                        );
                    } catch (e) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ errors: [String(e)] }));
                    }
                });
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
