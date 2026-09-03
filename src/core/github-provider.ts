/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { chunkArray } from '../utils/array-utils';
import { fetchWithTimeout } from '../utils/fetch-utils';
import type { LoggerChannel } from '../utils/output-channel';
import type { AuthResult, CodeForgeAuthManager } from './code-forge-auth';
import type {
    AuthManageItem,
    ChangeStatusRequest,
    CodeForgeComment,
    CodeForgeCommentThread,
    CodeForgeProvider,
    GitRemote,
    StackCommitNode,
    StackSyncResult,
} from './code-forge-provider';
import { type Event, EventEmitter } from './host/events';
import type { CodeForgeChangeInfo } from './jj-types';

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

export const GitHubRepoMetadataSchema = z.object({
    data: z
        .object({
            repository: z
                .object({
                    id: z.string(),
                    defaultBranchRef: z
                        .object({
                            name: z.string(),
                        })
                        .nullable()
                        .optional(),
                })
                .nullable()
                .optional(),
        })
        .nullable()
        .optional(),
    errors: z.array(z.unknown()).nullable().optional(),
});
export type GitHubRepoMetadataGql = z.infer<typeof GitHubRepoMetadataSchema>;

export const GitHubStackedPrNodeSchema = z.object({
    id: z.string(),
    number: z.number(),
    url: z.string(),
    baseRefName: z.string(),
    headRefName: z.string().nullable().optional(),
    headRepository: z
        .object({
            owner: z
                .object({
                    login: z.string(),
                })
                .optional(),
        })
        .nullable()
        .optional(),
});
export type GitHubStackedPrNode = z.infer<typeof GitHubStackedPrNodeSchema>;

export const GitHubStackedPrsResponseSchema = z.object({
    data: z
        .object({
            repository: z
                .record(
                    z.string(),
                    z
                        .object({
                            nodes: z.array(GitHubStackedPrNodeSchema.nullable()).optional(),
                        })
                        .nullable()
                        .optional(),
                )
                .nullable()
                .optional(),
        })
        .nullable()
        .optional(),
    errors: z.array(z.unknown()).nullable().optional(),
});
export type GitHubStackedPrsResponseGql = z.infer<typeof GitHubStackedPrsResponseSchema>;

export const GitHubCreatePrResponseSchema = z.object({
    data: z
        .object({
            createPullRequest: z
                .object({
                    pullRequest: GitHubStackedPrNodeSchema.nullable().optional(),
                })
                .nullable()
                .optional(),
        })
        .nullable()
        .optional(),
    errors: z.array(z.unknown()).nullable().optional(),
});
export type GitHubCreatePrResponseGql = z.infer<typeof GitHubCreatePrResponseSchema>;

export const GitHubUpdatePrResponseSchema = z.object({
    data: z
        .object({
            updatePullRequest: z
                .object({
                    pullRequest: GitHubStackedPrNodeSchema.nullable().optional(),
                })
                .nullable()
                .optional(),
        })
        .nullable()
        .optional(),
    errors: z.array(z.unknown()).nullable().optional(),
});
export type GitHubUpdatePrResponseGql = z.infer<typeof GitHubUpdatePrResponseSchema>;

export const GitHubStackRecordSchema = z.object({
    number: z.number().optional(),
    stack_number: z.number().optional(),
    pull_requests: z
        .array(
            z.union([
                z.number(),
                z.object({
                    number: z.number(),
                }),
            ]),
        )
        .nullable()
        .optional(),
});
export type GitHubStackRecord = z.infer<typeof GitHubStackRecordSchema>;

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
        private outputChannel: LoggerChannel,
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
            return `${alias}: pullRequests(first: 10, headRefName: ${escapedName}, orderBy: { field: CREATED_AT, direction: DESC }) {
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
                    const openPr = chosenPrNodes.find((pr) => pr.state === 'OPEN');
                    const pr = openPr || chosenPrNodes[0];
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

    public async prepareStackedChanges(stack: StackCommitNode[]): Promise<void> {
        if (stack.length <= 1 || !this.owner || !this.repo) {
            return;
        }

        const token = await this.getSessionToken();
        if (!token) {
            return;
        }

        const apiUrl = process.env.JJ_VIEW_GITHUB_API_URL || 'https://api.github.com/graphql';
        const { defaultBranch } = await this.fetchRepositoryMetadata(apiUrl, token);
        const existingPrs = await this.fetchExistingPrs(apiUrl, token, stack);

        // Map bookmark names to their new positions in the stack
        const bookmarkIndexMap = new Map<string, number>();
        for (let i = 0; i < stack.length; i++) {
            bookmarkIndexMap.set(stack[i].bookmark, i);
        }

        for (let i = 0; i < stack.length; i++) {
            const node = stack[i];
            const existingPr = existingPrs.get(node.bookmark);
            if (!existingPr) {
                continue;
            }

            const baseIndex = bookmarkIndexMap.get(existingPr.baseRefName);
            // If the PR's baseRefName is a bookmark in the stack placed AFTER this commit (baseIndex > i),
            // this PR's base is about to become its descendant when branches are pushed.
            // Retarget it immediately to defaultBranch to prevent GitHub from auto-closing it upon push.
            if (baseIndex !== undefined && baseIndex > i) {
                this.outputChannel?.info(
                    `[GitHubProvider] Preemptively retargeting PR #${existingPr.number} (${node.bookmark}) from ${existingPr.baseRefName} to ${defaultBranch} before push to avoid forge auto-closure`,
                );
                try {
                    await this.retargetPullRequest(apiUrl, token, existingPr.id, defaultBranch);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.outputChannel?.warn(
                        `[GitHubProvider] Failed to preemptively retarget PR #${existingPr.number} (${node.bookmark}): ${msg}`,
                    );
                }
            }
        }
    }

    public async syncStackedChanges(stack: StackCommitNode[]): Promise<StackSyncResult> {
        const result: StackSyncResult = { created: [], retargeted: [], unchanged: [] };
        if (stack.length === 0 || !this.owner || !this.repo) {
            return result;
        }

        const token = await this.getSessionToken();
        if (!token) {
            return result;
        }

        const apiUrl = process.env.JJ_VIEW_GITHUB_API_URL || 'https://api.github.com/graphql';
        const { repositoryId, defaultBranch } = await this.fetchRepositoryMetadata(apiUrl, token);
        const existingPrs = await this.fetchExistingPrs(apiUrl, token, stack);

        const orderedPrNumbers: number[] = [];
        // Process each commit in the stack
        for (let i = 0; i < stack.length; i++) {
            const node = stack[i];
            const expectedBase = i === 0 ? defaultBranch : stack[i - 1].bookmark;
            const existingPr = existingPrs.get(node.bookmark);

            try {
                if (existingPr) {
                    if (existingPr.baseRefName !== expectedBase) {
                        await this.retargetPullRequest(apiUrl, token, existingPr.id, expectedBase);
                        orderedPrNumbers.push(existingPr.number);
                        result.retargeted.push({
                            changeId: node.changeId,
                            prNumber: existingPr.number,
                            url: existingPr.url,
                            oldBase: existingPr.baseRefName,
                            newBase: expectedBase,
                        });
                        continue;
                    }
                    orderedPrNumbers.push(existingPr.number);
                    result.unchanged.push({
                        changeId: node.changeId,
                        prNumber: existingPr.number,
                    });
                    continue;
                }

                const lines = node.description.trim().split('\n');
                const title = lines[0]?.trim() || `Commit ${node.changeId.slice(0, 8)}`;
                const body = lines.slice(1).join('\n').trim();

                const createdPr = await this.createPullRequest(
                    apiUrl,
                    token,
                    repositoryId,
                    expectedBase,
                    node.bookmark,
                    title,
                    body,
                );
                if (createdPr) {
                    orderedPrNumbers.push(createdPr.number);
                    result.created.push({
                        changeId: node.changeId,
                        prNumber: createdPr.number,
                        url: createdPr.url,
                        base: expectedBase,
                        head: node.bookmark,
                    });
                } else {
                    this.outputChannel?.warn(
                        `[GitHubProvider] Failed to create pull request for ${node.bookmark}: createPullRequest returned empty response.`,
                    );
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.outputChannel?.warn(`[GitHubProvider] Failed to sync PR for ${node.bookmark}: ${msg}`);
            }
        }

        // Only register native stack if the entire stack succeeded without gaps or failures
        if (orderedPrNumbers.length > 1 && orderedPrNumbers.length === stack.length) {
            await this.registerNativeStack(apiUrl, token, orderedPrNumbers);
        }

        return result;
    }

    private async fetchRepositoryMetadata(
        apiUrl: string,
        token: string,
    ): Promise<{ repositoryId: string; defaultBranch: string }> {
        const repoQuery = `
        query($owner: String!, $name: String!) {
            repository(owner: $owner, name: $name) {
                id
                defaultBranchRef {
                    name
                }
            }
        }
        `;
        const repoResp = await fetchWithTimeout(apiUrl, 15000, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'jj-view-vscode-extension',
            },
            body: JSON.stringify({
                query: repoQuery,
                variables: { owner: this.owner, name: this.repo },
            }),
        });
        if (!repoResp.ok) {
            throw new Error(`Failed to query repository metadata: ${repoResp.statusText}`);
        }
        const rawJson = (await repoResp.json()) as unknown;
        const parsed = GitHubRepoMetadataSchema.safeParse(rawJson);
        if (!parsed.success) {
            throw new Error(`Failed to parse repository metadata: ${parsed.error.message}`);
        }
        const repoJson = parsed.data;
        if (repoJson.errors && repoJson.errors.length > 0) {
            throw new Error(`GraphQL errors: ${JSON.stringify(repoJson.errors)}`);
        }
        const repositoryId = repoJson.data?.repository?.id;
        if (!repositoryId) {
            throw new Error('Repository ID not found on GitHub.');
        }
        const defaultBranch = repoJson.data?.repository?.defaultBranchRef?.name || 'main';
        return { repositoryId, defaultBranch };
    }

    private async fetchExistingPrs(
        apiUrl: string,
        token: string,
        stack: StackCommitNode[],
    ): Promise<Map<string, GitHubStackedPrNode>> {
        const aliasQueries = stack
            .map(
                (node, i) =>
                    `pr_${i}: pullRequests(first: 10, headRefName: ${JSON.stringify(node.bookmark)}, states: [OPEN], orderBy: { field: CREATED_AT, direction: DESC }) { nodes { id number url baseRefName headRefName headRepository { owner { login } } } }`,
            )
            .join('\n');
        const prsQuery = `
        query($owner: String!, $name: String!) {
            repository(owner: $owner, name: $name) {
                ${aliasQueries}
            }
        }
        `;
        const prsResp = await fetchWithTimeout(apiUrl, 15000, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'jj-view-vscode-extension',
            },
            body: JSON.stringify({
                query: prsQuery,
                variables: { owner: this.owner, name: this.repo },
            }),
        });
        if (!prsResp.ok) {
            throw new Error(`Failed to query existing pull requests: ${prsResp.statusText}`);
        }
        const rawJson = (await prsResp.json()) as unknown;
        const parsed = GitHubStackedPrsResponseSchema.safeParse(rawJson);
        if (!parsed.success) {
            throw new Error(`Failed to parse existing PRs response: ${parsed.error.message}`);
        }
        const prsJson = parsed.data;
        if (prsJson.errors && prsJson.errors.length > 0) {
            throw new Error(`GraphQL errors: ${JSON.stringify(prsJson.errors)}`);
        }

        const existingPrs = new Map<string, GitHubStackedPrNode>();
        const repositoryData = prsJson.data?.repository;
        if (repositoryData) {
            for (let i = 0; i < stack.length; i++) {
                const prList = repositoryData[`pr_${i}`]?.nodes;
                if (prList && prList.length > 0) {
                    const validPr = prList.find((p) => {
                        if (!p) {
                            return false;
                        }
                        const headOwner = p.headRepository?.owner?.login;
                        if (headOwner && this.allowedOwners.size > 0) {
                            return this.allowedOwners.has(headOwner.toLowerCase());
                        }
                        return true;
                    });
                    if (validPr) {
                        existingPrs.set(stack[i].bookmark, validPr);
                    }
                }
            }
        }
        return existingPrs;
    }

    private async retargetPullRequest(
        apiUrl: string,
        token: string,
        pullRequestId: string,
        baseRefName: string,
    ): Promise<void> {
        const updateMutation = `
        mutation($input: UpdatePullRequestInput!) {
            updatePullRequest(input: $input) {
                pullRequest {
                    id
                    number
                    url
                    baseRefName
                }
            }
        }
        `;
        const updateResp = await fetchWithTimeout(apiUrl, 15000, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'jj-view-vscode-extension',
            },
            body: JSON.stringify({
                query: updateMutation,
                variables: {
                    input: {
                        pullRequestId,
                        baseRefName,
                    },
                },
            }),
        });
        if (!updateResp.ok) {
            throw new Error(`Failed to update PR base: ${updateResp.statusText}`);
        }
        const rawJson = (await updateResp.json()) as unknown;
        const parsed = GitHubUpdatePrResponseSchema.safeParse(rawJson);
        if (!parsed.success) {
            throw new Error(`Failed to parse update PR response: ${parsed.error.message}`);
        }
        const updateJson = parsed.data;
        if (updateJson.errors && updateJson.errors.length > 0) {
            throw new Error(`GraphQL errors: ${JSON.stringify(updateJson.errors)}`);
        }
    }

    private async createPullRequest(
        apiUrl: string,
        token: string,
        repositoryId: string,
        baseRefName: string,
        headRefName: string,
        title: string,
        body: string,
    ): Promise<GitHubStackedPrNode | undefined> {
        const createMutation = `
        mutation($input: CreatePullRequestInput!) {
            createPullRequest(input: $input) {
                pullRequest {
                    id
                    number
                    url
                    baseRefName
                    headRefName
                }
            }
        }
        `;
        const createResp = await fetchWithTimeout(apiUrl, 15000, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'jj-view-vscode-extension',
            },
            body: JSON.stringify({
                query: createMutation,
                variables: {
                    input: {
                        repositoryId,
                        baseRefName,
                        headRefName,
                        title,
                        body,
                    },
                },
            }),
        });
        if (!createResp.ok) {
            throw new Error(`Failed to create PR: ${createResp.statusText}`);
        }
        const rawJson = (await createResp.json()) as unknown;
        const parsed = GitHubCreatePrResponseSchema.safeParse(rawJson);
        if (!parsed.success) {
            throw new Error(`Failed to parse create PR response: ${parsed.error.message}`);
        }
        const createJson = parsed.data;
        if (createJson.errors && createJson.errors.length > 0) {
            throw new Error(`GraphQL errors: ${JSON.stringify(createJson.errors)}`);
        }
        return createJson.data?.createPullRequest?.pullRequest ?? undefined;
    }

    private getRestApiBaseUrl(gqlUrl: string): string {
        const customRestUrl = process.env.JJ_VIEW_GITHUB_REST_API_URL;
        if (customRestUrl && customRestUrl.trim().length > 0) {
            return customRestUrl.trim();
        }
        try {
            const parsed = new URL(gqlUrl);
            if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
                return `${parsed.protocol}//${parsed.host}`;
            }
            if (parsed.hostname !== 'api.github.com') {
                return `${parsed.protocol}//${parsed.host}/api/v3`;
            }
        } catch {
            // Fall back to default GitHub REST API
        }
        return 'https://api.github.com';
    }

    private async findExistingStack(
        restBaseUrl: string,
        token: string,
        pullRequestNumbers: number[],
    ): Promise<{ number: number; prNumbers: number[] } | undefined> {
        if (!this.owner || !this.repo) {
            return undefined;
        }

        for (const prNum of pullRequestNumbers) {
            const endpoint = `${restBaseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/stacks?pull_request=${prNum}`;
            try {
                const response = await fetchWithTimeout(endpoint, 15000, {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28',
                        'User-Agent': 'jj-view-vscode-extension',
                    },
                });
                if (!response.ok) {
                    continue;
                }
                const rawJson = (await response.json()) as unknown;
                const list = Array.isArray(rawJson) ? rawJson : [rawJson];
                for (const item of list) {
                    const parsed = GitHubStackRecordSchema.safeParse(item);
                    if (!parsed.success) {
                        continue;
                    }
                    const record = parsed.data;
                    const stackNumber = record.number ?? record.stack_number;
                    if (typeof stackNumber !== 'number') {
                        continue;
                    }
                    const prNumbers: number[] = [];
                    for (const p of record.pull_requests || []) {
                        if (typeof p === 'number') {
                            prNumbers.push(p);
                        } else if (typeof p.number === 'number') {
                            prNumbers.push(p.number);
                        }
                    }
                    return { number: stackNumber, prNumbers };
                }
            } catch {
                // Continue checking next PR
            }
        }
        return undefined;
    }

    private async registerNativeStack(apiUrl: string, token: string, pullRequestNumbers: number[]): Promise<void> {
        if (!this.owner || !this.repo || pullRequestNumbers.length <= 1) {
            return;
        }

        const restBaseUrl = this.getRestApiBaseUrl(apiUrl);
        const endpoint = `${restBaseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/stacks`;

        try {
            const response = await fetchWithTimeout(endpoint, 15000, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'Content-Type': 'application/json',
                    'User-Agent': 'jj-view-vscode-extension',
                },
                body: JSON.stringify({
                    pull_requests: pullRequestNumbers,
                }),
            });

            if (response.status === 201 || response.ok) {
                this.outputChannel?.info(
                    `[GitHubProvider] Successfully registered native GitHub stack for PRs: ${pullRequestNumbers.join(', ')}`,
                );
                return;
            }

            // 422 indicates that one or more pull requests are already part of an existing stack.
            // In that case, look up the existing stack and append the new PR(s) to it via /stacks/{stack_number}/add.
            if (response.status === 422) {
                const existingStack = await this.findExistingStack(restBaseUrl, token, pullRequestNumbers);
                if (existingStack) {
                    const existingSet = new Set(existingStack.prNumbers);
                    const toAdd = pullRequestNumbers.filter((num) => !existingSet.has(num));

                    if (toAdd.length === 0) {
                        this.outputChannel?.debug(
                            `[GitHubProvider] All PRs [${pullRequestNumbers.join(', ')}] already belong to stack #${existingStack.number}`,
                        );
                        return;
                    }

                    const addEndpoint = `${restBaseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/stacks/${existingStack.number}/add`;
                    const addResp = await fetchWithTimeout(addEndpoint, 15000, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${token}`,
                            Accept: 'application/vnd.github+json',
                            'X-GitHub-Api-Version': '2022-11-28',
                            'Content-Type': 'application/json',
                            'User-Agent': 'jj-view-vscode-extension',
                        },
                        body: JSON.stringify({
                            pull_requests: toAdd,
                        }),
                    });

                    if (addResp.status === 200 || addResp.status === 201 || addResp.ok) {
                        this.outputChannel?.info(
                            `[GitHubProvider] Successfully added PRs [${toAdd.join(', ')}] to native GitHub stack #${existingStack.number}`,
                        );
                        return;
                    }

                    this.outputChannel?.debug(
                        `[GitHubProvider] Failed to add PRs to stack #${existingStack.number} (status ${addResp.status}): ${addResp.statusText}`,
                    );
                    return;
                }
            }

            this.outputChannel?.debug(
                `[GitHubProvider] Native stack registration returned status ${response.status}: ${response.statusText}`,
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.outputChannel?.debug(`[GitHubProvider] Optional native stack registration skipped: ${msg}`);
        }
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
        thread: CodeForgeCommentThread,
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
                variables: { threadId: thread.id, body },
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

    public async resolveCommentThread(
        _changeId: string,
        thread: CodeForgeCommentThread,
        resolved: boolean,
    ): Promise<void> {
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
                variables: { threadId: thread.id },
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
