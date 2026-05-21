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
}

interface GqlPrNode {
    id: string;
    number: number;
    state: string;
    mergeable: string;
    url: string;
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
    private server: http.Server | undefined;
    public url = '';
    public requests: { url: string; body: string }[] = [];

    public registerPR(bookmark: string, pr: FakePrInfo) {
        this.prs.set(bookmark, pr);
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
                        const parsedBody = JSON.parse(body) as { query?: string };
                        const query = parsedBody.query || '';

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
