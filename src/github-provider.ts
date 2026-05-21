/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { ChangeStatusRequest, CodeForgeProvider, GitRemote } from './code-forge-provider';
import type { CodeForgeChangeInfo } from './jj-types';
import { chunkArray } from './utils/array-utils';
import { fetchWithTimeout } from './utils/fetch-utils';

interface GitHubPrNode {
    id: string;
    number: number;
    state: string;
    mergeable: string;
    reviewDecision?: string | null;
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
                statusCheckRollup?: {
                    state: string;
                } | null;
            };
        }[];
    };
}

interface GitHubGqlResponse {
    errors?: unknown[];
    data?: {
        repository?: Record<
            string,
            {
                nodes?: GitHubPrNode[];
            }
        >;
    };
}

export class GitHubProvider implements CodeForgeProvider {
    public readonly id = 'github';
    public readonly displayName = 'GitHub';
    public readonly changeTerm = 'PR' as const;

    private cache = new Map<string, CodeForgeChangeInfo>();
    private owner: string | undefined;
    private repo: string | undefined;
    private tokenRequested = false;

    private _onDidUpdate = new vscode.EventEmitter<void>();
    public readonly onDidUpdate = this._onDidUpdate.event;

    constructor(private outputChannel?: vscode.OutputChannel) {}

    public async detect(_workspaceRoot: string, remotes: GitRemote[]): Promise<boolean> {
        const remotePriority = (name: string): number => {
            const lower = name.toLowerCase();
            if (lower === 'origin') {
                return 0;
            }
            if (lower === 'upstream') {
                return 1;
            }
            return 2;
        };
        const prioritized = [...remotes].sort((a, b) => remotePriority(a.name) - remotePriority(b.name));

        let owner: string | undefined;
        let repo: string | undefined;

        for (const remote of prioritized) {
            const parsed = this.parseGitHubUrl(remote.url);
            if (parsed) {
                owner = parsed.owner;
                repo = parsed.repo;
                break;
            }
        }

        if (owner && repo) {
            if (this.owner !== owner || this.repo !== repo) {
                this.clearCache();
            }
            this.owner = owner;
            this.repo = repo;
            this.outputChannel?.appendLine(`[GitHubProvider] Detected GitHub repo: ${this.owner}/${this.repo}`);
            return true;
        }

        this.owner = undefined;
        this.repo = undefined;
        return false;
    }

    private parseGitHubUrl(url: string): { owner: string; repo: string } | undefined {
        let cleanUrl = url.trim();
        if (cleanUrl.endsWith('.git')) {
            cleanUrl = cleanUrl.slice(0, -4);
        }
        const match = cleanUrl.match(/(?:^|[^a-zA-Z0-9-])github\.com[:/]([^/]+)\/([^/]+?)\/?$/);
        if (match) {
            return {
                owner: match[1],
                repo: match[2],
            };
        }
        return undefined;
    }

    private async getSessionToken(): Promise<string | undefined> {
        if (process.env.JJ_VIEW_GITHUB_TOKEN) {
            return process.env.JJ_VIEW_GITHUB_TOKEN;
        }
        try {
            // Try silently first
            let session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
            if (session) {
                return session.accessToken;
            }
            // If silent failed, prompt once
            if (!this.tokenRequested) {
                this.tokenRequested = true;
                session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
                return session?.accessToken;
            }
        } catch (e) {
            this.outputChannel?.appendLine(`[GitHubProvider] Failed to get OAuth token: ${e}`);
        }
        return undefined;
    }

    public getCachedChangeInfo(
        _changeId?: string,
        _description?: string,
        bookmarks?: string[],
    ): CodeForgeChangeInfo | undefined {
        if (bookmarks && bookmarks.length > 0) {
            for (const bookmark of bookmarks) {
                const info = this.cache.get(bookmark);
                if (info) {
                    return { ...info };
                }
            }
        }
        return undefined;
    }

    public async fetchStatuses(changes: ChangeStatusRequest[]): Promise<boolean> {
        if (!this.owner || !this.repo || changes.length === 0) {
            return false;
        }

        const bookmarkNames = new Set<string>();
        for (const change of changes) {
            if (change.bookmarks) {
                for (const bookmark of change.bookmarks) {
                    bookmarkNames.add(bookmark);
                }
            }
        }

        if (bookmarkNames.size === 0) {
            return false;
        }

        const bookmarkArray = Array.from(bookmarkNames);
        const BATCH_SIZE = 20;
        const batches = chunkArray(bookmarkArray, BATCH_SIZE);

        let changed = false;

        const processBatch = async (batch: string[]): Promise<void> => {
            try {
                const fetchedInfoMap = await this.fetchBatchFromNetwork(batch);
                for (const bookmark of batch) {
                    const info = fetchedInfoMap.get(bookmark);
                    const oldInfo = this.cache.get(bookmark);

                    if (info) {
                        const matchingChange = changes.find((c) => c.bookmarks?.includes(bookmark));
                        if (matchingChange) {
                            info.contentSynced = info.currentRevision === matchingChange.commitId;
                        }
                        this.cache.set(bookmark, info);
                    } else {
                        this.cache.delete(bookmark);
                    }

                    if (JSON.stringify(oldInfo) !== JSON.stringify(info)) {
                        changed = true;
                    }
                }
            } catch (error) {
                this.outputChannel?.appendLine(`[GitHubProvider] Failed to fetch statuses for batch: ${error}`);
            }
        };

        await Promise.all(batches.map((batch) => processBatch(batch)));

        if (changed) {
            this._onDidUpdate.fire();
        }
        return changed;
    }

    private async fetchBatchFromNetwork(bookmarkNames: string[]): Promise<Map<string, CodeForgeChangeInfo>> {
        const results = new Map<string, CodeForgeChangeInfo>();
        const token = await this.getSessionToken();
        if (!token) {
            throw new Error('No GitHub session token available');
        }
        if (!this.owner || !this.repo) {
            return results;
        }

        const aliasQueries = bookmarkNames.map((name, index) => {
            const alias = `pr_${index}`;
            const escapedName = JSON.stringify(name);
            return `${alias}: pullRequests(first: 1, headRefName: ${escapedName}) {
                nodes {
                    id
                    number
                    state
                    url
                    mergeable
                    reviewDecision
                    headRefName
                    # commits(last: 1) fetches the last commit in chronological order,
                    # which is the HEAD (latest) commit of the PR.
                    commits(last: 1) {
                        nodes {
                            commit {
                                oid
                                message
                                parents(first: 10) {
                                    nodes {
                                        oid
                                    }
                                }
                                statusCheckRollup {
                                    state
                                }
                            }
                        }
                    }
                    reviewThreads(first: 100) {
                        nodes {
                            isResolved
                        }
                    }
                }
            }`;
        });

        const query = `
        query($owner: String!, $name: String!) {
            repository(owner: $owner, name: $name) {
                ${aliasQueries.join('\n')}
            }
        }
        `;

        const apiUrl = process.env.JJ_VIEW_GITHUB_API_URL || 'https://api.github.com/graphql';
        const response = await fetchWithTimeout(apiUrl, 15000, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'jj-view-vscode-extension',
            },
            body: JSON.stringify({
                query,
                variables: {
                    owner: this.owner,
                    name: this.repo,
                },
            }),
        });

        if (!response.ok) {
            throw new Error(`GraphQL request failed with status: ${response.statusText}`);
        }

        const json = (await response.json()) as GitHubGqlResponse;
        if (json.errors) {
            throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
        }

        const repoData = json.data?.repository;
        if (repoData) {
            for (let i = 0; i < bookmarkNames.length; i++) {
                const alias = `pr_${i}`;
                const prNodes = repoData[alias]?.nodes;
                if (Array.isArray(prNodes) && prNodes.length > 0) {
                    const pr = prNodes[0];
                    const info = this.parseGitHubPr(pr);
                    if (info) {
                        results.set(bookmarkNames[i], info);
                    }
                }
            }
        }

        return results;
    }

    private parseGitHubPr(pr: GitHubPrNode): CodeForgeChangeInfo | undefined {
        const stateMap: Record<string, 'NEW' | 'MERGED' | 'ABANDONED'> = {
            OPEN: 'NEW',
            MERGED: 'MERGED',
            CLOSED: 'ABANDONED',
        };

        const unresolvedComments = pr.reviewThreads?.nodes?.filter((t) => !t.isResolved).length || 0;
        const commitNode = pr.commits?.nodes?.[0]?.commit;
        const currentRevision = commitNode?.oid;
        const remoteParents = commitNode?.parents?.nodes?.map((p) => p.oid);
        const remoteDescription = commitNode?.message;

        const reviewDecision = pr.reviewDecision;
        const statusCheckRollup = commitNode?.statusCheckRollup;

        const isMergeable = pr.mergeable === 'MERGEABLE';
        const isReviewApproved = !reviewDecision || reviewDecision === 'APPROVED';
        const isStatusChecksOk = !statusCheckRollup || statusCheckRollup.state === 'SUCCESS';

        const submittable = isMergeable && isReviewApproved && isStatusChecksOk;

        return {
            id: pr.id,
            number: pr.number,
            displayLabel: `PR #${pr.number}`,
            providerName: 'GitHub',
            status: stateMap[pr.state] || 'NEW',
            submittable,
            url: pr.url,
            unresolvedComments,
            currentRevision,
            remoteParents,
            remoteDescription,
        };
    }

    public getUploadCommand(
        revision: string,
        hasBookmark?: boolean,
    ): { subcommand: string; args: string[] } | undefined {
        const args = ['push'];
        if (!hasBookmark) {
            args.push('-c', revision);
        } else {
            args.push('-r', revision);
        }
        return { subcommand: 'git', args };
    }

    public clearCache(): void {
        this.cache.clear();
        this.tokenRequested = false;
        this._onDidUpdate.fire();
    }

    public activate(): void {
        this.tokenRequested = false;
        this.outputChannel?.appendLine('[GitHubProvider] Activated');
    }

    public deactivate(): void {
        this.outputChannel?.appendLine('[GitHubProvider] Deactivated');
    }
}
