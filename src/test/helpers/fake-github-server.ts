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
    baseRefName?: string;
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
    baseRefName?: string;
    headRefName?: string;
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
    private prs = new Map<string, FakePrInfo[]>();
    private threads = new Map<string, FakeReviewThread[]>(); // prId -> FakeReviewThread[]
    private server: http.Server | undefined;
    public url = '';
    public requests: { url: string; body: string }[] = [];
    public createdPrs: Array<{
        repositoryId?: string;
        baseRefName: string;
        headRefName: string;
        title: string;
        body?: string;
        number: number;
    }> = [];
    public retargetedPrs: Array<{ pullRequestId: string; baseRefName: string }> = [];
    public createdStacks: Array<{ pull_requests: number[] }> = [];
    public addedToStacks: Array<{ stackNumber: number; pull_requests: number[] }> = [];
    public stacks: Array<{ id: number; number: number; pull_requests: Array<{ number: number }> }> = [];
    public stacksResponseStatus = 201;
    public defaultBranch = 'main';

    public registerPR(bookmark: string, pr: FakePrInfo) {
        const list = this.prs.get(bookmark) ?? [];
        list.push(pr);
        this.prs.set(bookmark, list);
    }

    public registerReviewThreads(prId: string, threads: FakeReviewThread[]) {
        this.threads.set(prId, threads);
    }

    public clear() {
        this.requests = [];
        this.createdPrs = [];
        this.retargetedPrs = [];
        this.createdStacks = [];
        this.addedToStacks = [];
        this.stacks = [];
        this.stacksResponseStatus = 201;
        this.defaultBranch = 'main';
        this.prs.clear();
        this.threads.clear();
    }

    public clearRequests() {
        this.requests = [];
    }

    public async start(): Promise<string> {
        this.server = http.createServer((req, res) => {
            const urlStr = req.url || '';

            if (req.method === 'GET' && urlStr.includes('/stacks')) {
                const prMatch = urlStr.match(/pull_request=(\d+)/);
                if (prMatch) {
                    const prNum = parseInt(prMatch[1], 10);
                    const matched = this.stacks.filter((s) => s.pull_requests.some((p) => p.number === prNum));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(matched));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(this.stacks));
                return;
            }

            if (req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => {
                    body += chunk.toString();
                });
                req.on('end', () => {
                    this.requests.push({ url: urlStr, body });

                    if (urlStr.includes('/stacks')) {
                        const addMatch = urlStr.match(/\/stacks\/(\d+)\/add/);
                        if (addMatch) {
                            const stackNum = parseInt(addMatch[1], 10);
                            let stackBody: { pull_requests?: number[] };
                            try {
                                stackBody = JSON.parse(body) as { pull_requests?: number[] };
                            } catch {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Invalid JSON' }));
                                return;
                            }
                            const toAdd = stackBody.pull_requests || [];
                            const stack = this.stacks.find((s) => s.number === stackNum);
                            if (stack) {
                                for (const n of toAdd) {
                                    stack.pull_requests.push({ number: n });
                                }
                            }
                            this.addedToStacks.push({ stackNumber: stackNum, pull_requests: toAdd });
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ id: stackNum, stack_number: stackNum }));
                            return;
                        }

                        try {
                            const stackBody = JSON.parse(body) as { pull_requests?: number[] };
                            if (stackBody.pull_requests) {
                                this.createdStacks.push({ pull_requests: stackBody.pull_requests });
                                if (this.stacksResponseStatus === 201) {
                                    this.stacks.push({
                                        id: this.stacks.length + 1,
                                        number: this.stacks.length + 1,
                                        pull_requests: stackBody.pull_requests.map((n) => ({ number: n })),
                                    });
                                }
                            }
                        } catch {
                            // ignore parse error
                        }
                        res.writeHead(this.stacksResponseStatus, { 'Content-Type': 'application/json' });
                        if (this.stacksResponseStatus === 201) {
                            res.end(JSON.stringify({ id: 1, stack_number: 1 }));
                        } else {
                            res.end(JSON.stringify({ message: 'Error' }));
                        }
                        return;
                    }

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

                        if (query.includes('defaultBranchRef')) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(
                                JSON.stringify({
                                    data: {
                                        repository: {
                                            id: 'repo_id_123',
                                            defaultBranchRef: {
                                                name: this.defaultBranch,
                                            },
                                        },
                                    },
                                }),
                            );
                            return;
                        }

                        if (query.includes('createPullRequest')) {
                            const variables = parsedBody.variables as
                                | {
                                      input?: {
                                          repositoryId?: string;
                                          baseRefName: string;
                                          headRefName: string;
                                          title: string;
                                          body?: string;
                                      };
                                  }
                                | undefined;
                            const input = variables?.input;
                            const existingNumbers: number[] = [];
                            for (const list of this.prs.values()) {
                                for (const p of list) {
                                    existingNumbers.push(p.number);
                                }
                            }
                            const prNumber = Math.max(99, ...existingNumbers) + 1;
                            const prId = `pr_node_${prNumber}`;
                            const prUrl = `https://github.com/test-owner/test-repo/pull/${prNumber}`;
                            if (input) {
                                this.createdPrs.push({ ...input, number: prNumber });
                                const newPr: FakePrInfo = {
                                    id: prId,
                                    number: prNumber,
                                    state: 'OPEN',
                                    mergeable: 'MERGEABLE',
                                    url: prUrl,
                                    baseRefName: input.baseRefName,
                                };
                                const list = this.prs.get(input.headRefName) ?? [];
                                list.push(newPr);
                                this.prs.set(input.headRefName, list);
                            }
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(
                                JSON.stringify({
                                    data: {
                                        createPullRequest: {
                                            pullRequest: {
                                                id: prId,
                                                number: prNumber,
                                                url: prUrl,
                                                baseRefName: input?.baseRefName || this.defaultBranch,
                                                headRefName: input?.headRefName || '',
                                            },
                                        },
                                    },
                                }),
                            );
                            return;
                        }

                        if (query.includes('updatePullRequest')) {
                            const variables = parsedBody.variables as
                                | { input?: { pullRequestId: string; baseRefName: string } }
                                | undefined;
                            const input = variables?.input;
                            let matchedPr: FakePrInfo | undefined;
                            if (input) {
                                this.retargetedPrs.push(input);
                                for (const list of this.prs.values()) {
                                    for (const pr of list) {
                                        if (pr.id === input.pullRequestId) {
                                            pr.baseRefName = input.baseRefName;
                                            matchedPr = pr;
                                            break;
                                        }
                                    }
                                    if (matchedPr) {
                                        break;
                                    }
                                }
                            }
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(
                                JSON.stringify({
                                    data: {
                                        updatePullRequest: {
                                            pullRequest: {
                                                id: input?.pullRequestId,
                                                number: matchedPr?.number ?? 42,
                                                url: matchedPr?.url ?? 'https://github.com/owner/repo/pull/42',
                                                baseRefName: input?.baseRefName,
                                            },
                                        },
                                    },
                                }),
                            );
                            return;
                        }

                        // Parse queries in the format:
                        // pr_0: pullRequests(first: 10, headRefName: "some-bookmark"...) {
                        const regex = /(\w+):\s*pullRequests\s*\([^)]*headRefName:\s*"([^"]+)"[^)]*\)/g;
                        let match = regex.exec(query);
                        const repositoryData: Record<string, { nodes: GqlPrNode[] } | null> = {};

                        while (match !== null) {
                            const alias = match[1];
                            const bookmarkName = match[2];

                            const prList = this.prs.get(bookmarkName) ?? [];
                            const isStatesOpenOnly = query.includes('states: [OPEN]');
                            const matchingPrs = prList.filter((p) => !isStatesOpenOnly || p.state === 'OPEN');
                            const prNodes: GqlPrNode[] = matchingPrs.map((pr) => {
                                const prNode: GqlPrNode = {
                                    id: pr.id,
                                    number: pr.number,
                                    state: pr.state,
                                    mergeable: pr.mergeable,
                                    url: pr.url,
                                    baseRefName: pr.baseRefName || 'main',
                                    headRefName: bookmarkName,
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

                                return prNode;
                            });

                            repositoryData[alias] = {
                                nodes: prNodes,
                            };

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
                this.server.closeAllConnections?.();
                this.server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }
}
