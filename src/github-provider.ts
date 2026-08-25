/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { AuthResult, CodeForgeAuthManager } from './code-forge-auth';
import type {
    AuthManageItem,
    ChangeStatusRequest,
    CodeForgeComment,
    CodeForgeCommentThread,
    CodeForgeProvider,
    GitRemote,
} from './code-forge-provider';
import { type Event, EventEmitter } from './common/events';
import type { CodeForgeChangeInfo } from './jj-types';
import { chunkArray } from './utils/array-utils';
import { fetchWithTimeout } from './utils/fetch-utils';
import type { JjLoggerChannel } from './utils/output-channel';

export const GitHubPrNodeSchema = z.object({
    id: z.string(),
    number: z.number(),
    state: z.string(),
    mergeable: z.string(),
    reviewDecision: z.string().nullable().optional(),
    url: z.string(),
    headRepository: z
        .object({
            owner: z.object({
                login: z.string(),
            }),
        })
        .nullable()
        .optional(),
    reviewThreads: z
        .object({
            nodes: z
                .array(
                    z.object({
                        isResolved: z.boolean(),
                    }),
                )
                .optional(),
        })
        .optional(),
    commits: z
        .object({
            nodes: z
                .array(
                    z.object({
                        commit: z
                            .object({
                                oid: z.string(),
                                message: z.string(),
                                parents: z
                                    .object({
                                        nodes: z
                                            .array(
                                                z.object({
                                                    oid: z.string(),
                                                }),
                                            )
                                            .optional(),
                                    })
                                    .optional(),
                                statusCheckRollup: z
                                    .object({
                                        state: z.string(),
                                    })
                                    .nullable()
                                    .optional(),
                            })
                            .optional(),
                    }),
                )
                .optional(),
        })
        .optional(),
});
export type GitHubPrNode = z.infer<typeof GitHubPrNodeSchema>;

export const GitHubGqlResponseSchema = z.object({
    errors: z.array(z.unknown()).optional(),
    data: z
        .object({
            repository: z
                .object({
                    parent: z
                        .record(
                            z.string(),
                            z.object({
                                nodes: z.array(GitHubPrNodeSchema).optional(),
                            }),
                        )
                        .nullable()
                        .optional(),
                })
                .catchall(z.unknown())
                .optional(),
        })
        .optional(),
});
export type GitHubGqlResponse = z.infer<typeof GitHubGqlResponseSchema>;

export const GitHubAliasSchema = z
    .object({
        nodes: z.array(GitHubPrNodeSchema).optional(),
    })
    .nullable()
    .optional();

interface GitHubAuthorGql {
    login: string;
    avatarUrl?: string;
}

interface GitHubCommentGql {
    id: string;
    body: string;
    createdAt: string;
    author?: GitHubAuthorGql | null;
}

interface GitHubReviewThreadNodeGql {
    id: string;
    isResolved: boolean;
    path: string;
    line?: number | null;
    comments: {
        nodes?: (GitHubCommentGql | null)[] | null;
    };
}

interface GitHubCommentsNodeResponseGql {
    data?: {
        node?: {
            reviewThreads?: {
                nodes?: (GitHubReviewThreadNodeGql | null)[] | null;
            } | null;
        } | null;
    } | null;
    errors?: unknown[] | null;
}

interface GitHubReplyResponseGql {
    data?: {
        addPullRequestReviewThreadReply?: {
            comment?: GitHubCommentGql | null;
        } | null;
    } | null;
    errors?: unknown[] | null;
}

export class GitHubProvider implements CodeForgeProvider {
    public readonly id = 'github';
    public readonly displayName = 'GitHub';
    public readonly changeTerm = 'PR' as const;
    public readonly isAuthManageable = true;

    private cache = new Map<string, CodeForgeChangeInfo>();
    private owner: string | undefined;
    private repo: string | undefined;
    private allowedOwners = new Set<string>();

    private _onDidUpdate = new EventEmitter<void>();
    public readonly onDidUpdate: Event<void> = this._onDidUpdate.event;

    constructor(
        private readonly authManager: CodeForgeAuthManager,
        private outputChannel?: JjLoggerChannel,
    ) {
        this.authManager.registerProvider(this.id);
    }

    public async detect(_workspaceRoot: string, remotes: GitRemote[]): Promise<boolean> {
        const remotePriority = (name: string): number => {
            const lower = name.toLowerCase();
            if (lower === 'upstream') {
                return 0;
            }
            if (lower === 'origin') {
                return 1;
            }
            return 2;
        };
        const prioritized = [...remotes].sort((a, b) => remotePriority(a.name) - remotePriority(b.name));

        this.allowedOwners.clear();
        for (const remote of remotes) {
            const parsed = this.parseGitHubUrl(remote.url);
            if (parsed) {
                this.allowedOwners.add(parsed.owner.toLowerCase());
            }
        }

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
            this.outputChannel?.info(`[GitHubProvider] Detected GitHub repo: ${this.owner}/${this.repo}`);
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

    public async fetchStatuses(
        changes: ChangeStatusRequest[],
        _jj: import('./jj-service').JjService,
    ): Promise<boolean> {
        if (!this.owner || !this.repo || changes.length === 0) {
            return false;
        }

        const bookmarkNames = new Set<string>();
        const bookmarkToCommitId = new Map<string, string>();
        for (const change of changes) {
            if (change.bookmarks) {
                for (const bookmark of change.bookmarks) {
                    bookmarkNames.add(bookmark);
                    bookmarkToCommitId.set(bookmark, change.commitId);
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
                const fetchedInfoMap = await this.fetchBatchFromNetwork(batch, bookmarkToCommitId);
                for (const bookmark of batch) {
                    const info = fetchedInfoMap.get(bookmark);
                    const oldInfo = this.cache.get(bookmark);

                    if (info) {
                        const matchingChange = changes.find((c) => c.bookmarks?.includes(bookmark));
                        if (matchingChange) {
                            info.contentSynced = info.currentRevision === matchingChange.commitId;
                            this.cache.set(bookmark, info);
                        } else {
                            this.cache.delete(bookmark);
                        }
                    } else {
                        this.cache.delete(bookmark);
                    }

                    if (JSON.stringify(oldInfo) !== JSON.stringify(info)) {
                        changed = true;
                    }
                }
            } catch (error) {
                this.outputChannel?.error(`[GitHubProvider] Failed to fetch statuses for batch: ${error}`);
            }
        };

        await Promise.all(batches.map((batch) => processBatch(batch)));

        if (changed) {
            this._onDidUpdate.fire();
        }
        return changed;
    }

    private async fetchBatchFromNetwork(
        bookmarkNames: string[],
        bookmarkToCommitId: Map<string, string>,
    ): Promise<Map<string, CodeForgeChangeInfo>> {
        const results = new Map<string, CodeForgeChangeInfo>();
        const token = await this.getSessionToken();
        if (!token) {
            return results;
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
                    headRepository {
                        owner {
                            login
                        }
                    }
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
                parent {
                    ${aliasQueries.join('\n')}
                }
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

        if (response.status === 401 && token) {
            this.outputChannel?.error(
                `[GitHubProvider] Request failed with 401 Unauthorized using token. Stored token may be invalid or expired.`,
            );
            await this.authManager.clearInvalidToken({
                providerId: 'github',
                secretTokenKey: 'github_token',
                currentToken: token,
                envTokenKey: 'JJ_VIEW_GITHUB_TOKEN',
            });
        }

        if (!response.ok) {
            throw new Error(`GraphQL request failed with status: ${response.statusText}`);
        }

        const parsedJson = await response.json();
        const validation = GitHubGqlResponseSchema.safeParse(parsedJson);
        if (!validation.success) {
            throw new Error(`Failed to validate GraphQL response: ${validation.error.message}`);
        }

        const json = validation.data;
        if (json.errors) {
            throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
        }

        const repoData = json.data?.repository;
        if (repoData) {
            const filterPrNodes = (nodes?: GitHubPrNode[], localCommitId?: string) => {
                return (nodes || []).filter((pr) => {
                    const headOwner = pr.headRepository?.owner?.login;
                    if (headOwner) {
                        return this.allowedOwners.size === 0 || this.allowedOwners.has(headOwner.toLowerCase());
                    }
                    if (localCommitId && pr.commits?.nodes?.[0]?.commit?.oid) {
                        return pr.commits.nodes[0].commit.oid === localCommitId;
                    }
                    return false;
                });
            };

            for (let i = 0; i < bookmarkNames.length; i++) {
                const alias = `pr_${i}`;
                const parentPrNodes = repoData.parent?.[alias]?.nodes;
                const prData = repoData[alias];
                const parsedAlias = GitHubAliasSchema.safeParse(prData);
                const prNodes = parsedAlias.success ? parsedAlias.data?.nodes : undefined;

                const localCommitId = bookmarkToCommitId.get(bookmarkNames[i]);
                const filteredParentNodes = filterPrNodes(parentPrNodes, localCommitId);
                const filteredChildNodes = filterPrNodes(prNodes, localCommitId);
                const chosenPrNodes = filteredParentNodes.length > 0 ? filteredParentNodes : filteredChildNodes;

                if (chosenPrNodes.length > 0) {
                    const pr = chosenPrNodes[0];
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

        const { reviewDecision } = pr;
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

    /**
     * Fetches comment threads from GitHub for a given pull request node ID.
     * Note: This GraphQL query is limited to retrieving the first 100 review threads
     * and the first 100 comments per thread. It does not perform cursor-based pagination.
     */
    public async getCommentThreads(changeId: string, signal?: AbortSignal): Promise<CodeForgeCommentThread[]> {
        const token = await this.getSessionToken();
        if (!token) {
            return [];
        }

        const query = `
        query($id: ID!) {
            node(id: $id) {
                ... on PullRequest {
                    reviewThreads(first: 100) {
                        nodes {
                            id
                            isResolved
                            path
                            line
                            comments(first: 100) {
                                nodes {
                                    id
                                    body
                                    createdAt
                                    author {
                                        login
                                        avatarUrl
                                    }
                                }
                            }
                        }
                    }
                }
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
                variables: { id: changeId },
            }),
            signal,
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch comments: ${response.statusText}`);
        }

        const json = (await response.json()) as GitHubCommentsNodeResponseGql;
        if (json.errors) {
            throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
        }

        const prNode = json.data?.node;
        if (!prNode) {
            return [];
        }

        const threads: CodeForgeCommentThread[] = [];
        const rawThreads = prNode.reviewThreads?.nodes || [];
        for (const rawThread of rawThreads) {
            if (!rawThread) {
                continue;
            }
            const comments: CodeForgeComment[] = [];
            const rawComments = rawThread.comments?.nodes || [];
            for (const c of rawComments) {
                if (!c) {
                    continue;
                }
                comments.push({
                    id: c.id,
                    author: {
                        name: c.author?.login || 'Unknown',
                        username: c.author?.login,
                        avatarUrl: c.author?.avatarUrl,
                    },
                    body: c.body,
                    createdAt: c.createdAt,
                });
            }

            threads.push({
                id: rawThread.id,
                filePath: rawThread.path,
                line: rawThread.line || undefined,
                isResolved: rawThread.isResolved,
                comments,
            });
        }

        return threads;
    }

    public async replyToCommentThread(
        _changeId: string,
        threadId: string,
        body: string,
        resolved?: boolean,
    ): Promise<CodeForgeComment> {
        const token = await this.getSessionToken();
        if (!token) {
            throw new Error('Not authenticated');
        }

        const query =
            resolved !== undefined
                ? `
            mutation($threadId: ID!, $body: String!) {
                addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
                    comment {
                        id
                        body
                        createdAt
                        author {
                            login
                            avatarUrl
                        }
                    }
                }
                resolve: ${resolved ? 'resolveReviewThread' : 'unresolveReviewThread'}(input: {threadId: $threadId}) {
                    thread {
                        id
                        isResolved
                    }
                }
            }
            `
                : `
            mutation($threadId: ID!, $body: String!) {
                addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
                    comment {
                        id
                        body
                        createdAt
                        author {
                            login
                            avatarUrl
                        }
                    }
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
                variables: { threadId, body },
            }),
        });

        if (!response.ok) {
            throw new Error(`Failed to post reply: ${response.statusText}`);
        }

        const json = (await response.json()) as GitHubReplyResponseGql;
        if (json.errors) {
            throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
        }

        const comment = json.data?.addPullRequestReviewThreadReply?.comment;
        if (!comment) {
            throw new Error('Failed to create reply: No comment returned');
        }

        return {
            id: comment.id,
            author: {
                name: comment.author?.login || 'Unknown',
                username: comment.author?.login,
                avatarUrl: comment.author?.avatarUrl,
            },
            body: comment.body,
            createdAt: comment.createdAt,
        };
    }

    public async resolveCommentThread(_changeId: string, threadId: string, resolved: boolean): Promise<void> {
        const token = await this.getSessionToken();
        if (!token) {
            throw new Error('Not authenticated');
        }

        const query = resolved
            ? `mutation($threadId: ID!) {
                resolveReviewThread(input: {threadId: $threadId}) {
                    thread {
                        id
                        isResolved
                    }
                }
            }`
            : `mutation($threadId: ID!) {
                unresolveReviewThread(input: {threadId: $threadId}) {
                    thread {
                        id
                        isResolved
                    }
                }
            }`;

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
                variables: { threadId },
            }),
        });

        if (!response.ok) {
            throw new Error(`Failed to toggle resolve: ${response.statusText}`);
        }

        const json = await response.json();
        const errors = (json as { errors?: unknown[] }).errors;
        if (errors) {
            throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
        }
    }

    public clearCache(): void {
        this.cache.clear();
        this._onDidUpdate.fire();
    }

    public activate(): void {
        this.outputChannel?.info('[GitHubProvider] Activated');
    }

    public deactivate(): void {
        this.outputChannel?.info('[GitHubProvider] Deactivated');
    }

    public dispose(): void {
        this._onDidUpdate.dispose();
    }

    private async getSessionToken(): Promise<string | undefined> {
        return this.authManager.getSessionToken(this.id, {
            scopes: ['repo'],
            envTokenKey: 'JJ_VIEW_GITHUB_TOKEN',
            secretTokenKey: 'github_token',
            promptMessage: 'GitHub authentication is required to fetch PR status.',
            signInLabel: 'Sign In (OAuth)',
            prompt: true,
            alternativeChoice: {
                label: 'Enter PAT',
                execute: () => this.promptForPat(),
            },
        });
    }

    public async promptForPat(): Promise<AuthResult> {
        return this.authManager.promptForPat({
            providerId: this.id,
            displayName: this.displayName,
            secretTokenKey: 'github_token',
            prompt: "Enter your GitHub Personal Access Token (PAT). Requires 'repo' scope.",
            placeHolder: 'ghp_...',
            clearCache: () => this.clearCache(),
        });
    }

    public async hasAuth(): Promise<boolean> {
        if (process.env.JJ_VIEW_GITHUB_TOKEN) {
            return true;
        }
        try {
            const storedToken = await this.authManager.secrets.get('github_token');
            if (storedToken) {
                return true;
            }
        } catch {}
        return this.authManager.hasOAuthSession(this.id, ['repo']);
    }

    public async getAuthManageItems(): Promise<AuthManageItem[]> {
        return this.authManager.getAuthManageItems(this.id, {
            displayName: this.displayName,
            scopes: ['repo'],
            envTokenKey: 'JJ_VIEW_GITHUB_TOKEN',
            secretTokenKey: 'github_token',
            hasAuth: () => this.hasAuth(),
            clearCache: () => this.clearCache(),
            promptForPat: () => this.promptForPat(),
        });
    }
}
