/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { AuthResult, CodeForgeAuthManager } from './code-forge-auth';
import type { AuthManageItem, ChangeStatusRequest, CodeForgeProvider, GitRemote } from './code-forge-provider';
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
    headRepository?: {
        owner: {
            login: string;
        };
    } | null;
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
        repository?: {
            parent?: Record<
                string,
                {
                    nodes?: GitHubPrNode[];
                }
            > | null;
        } & Record<
            string,
            | {
                  nodes?: GitHubPrNode[];
              }
            | Record<
                  string,
                  {
                      nodes?: GitHubPrNode[];
                  }
              >
            | null
            | undefined
        >;
    };
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

    private _onDidUpdate = new vscode.EventEmitter<void>();
    public readonly onDidUpdate = this._onDidUpdate.event;

    constructor(
        private readonly authManager: CodeForgeAuthManager,
        private outputChannel?: vscode.OutputChannel,
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
                this.outputChannel?.appendLine(`[GitHubProvider] Failed to fetch statuses for batch: ${error}`);
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
            this.outputChannel?.appendLine(
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

        const json = (await response.json()) as GitHubGqlResponse;
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
                const prData = repoData[alias] as { nodes?: GitHubPrNode[] } | undefined;
                const prNodes = prData?.nodes;

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
        this._onDidUpdate.fire();
    }

    public activate(): void {
        this.outputChannel?.appendLine('[GitHubProvider] Activated');
    }

    public deactivate(): void {
        this.outputChannel?.appendLine('[GitHubProvider] Deactivated');
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
