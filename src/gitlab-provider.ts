/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { AuthResult, CodeForgeAuthManager } from './code-forge-auth';
import type {
    AuthManageItem,
    ChangeStatusRequest,
    CodeForgeComment,
    CodeForgeCommentThread,
    CodeForgeProvider,
    GitRemote,
} from './code-forge-provider';
import type { CodeForgeChangeInfo } from './jj-types';
import { chunkArray } from './utils/array-utils';
import { fetchWithTimeout } from './utils/fetch-utils';
import type { JjLoggerChannel } from './utils/output-channel';

const GITLAB_EXTENSION_ID = 'gitlab.gitlab-workflow';

import { z } from 'zod';

export const GitLabMergeRequestSchema = z.object({
    id: z.number(),
    iid: z.number(),
    state: z.string(),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    has_conflicts: z.boolean().optional(),
    merge_status: z.string().optional(),
    detailed_merge_status: z.string().optional(),
    blocking_discussions_resolved: z.boolean().optional(),
    user_notes_count: z.number().optional(),
    web_url: z.string(),
    sha: z.string(),
    source_project_id: z.number().optional(),
});
export type GitLabMergeRequest = z.infer<typeof GitLabMergeRequestSchema>;

export const GitLabProjectInfoSchema = z.object({
    id: z.number().optional(),
    forked_from_project: z
        .object({
            id: z.number().optional(),
            path_with_namespace: z.string().optional(),
        })
        .optional(),
});
export type GitLabProjectInfo = z.infer<typeof GitLabProjectInfoSchema>;

interface GitLabAuthorGql {
    name: string;
    username: string;
    avatar_url?: string;
}

interface GitLabPositionGql {
    new_path?: string;
    new_line?: number;
}

interface GitLabNoteGql {
    id: number;
    body: string;
    created_at: string;
    author: GitLabAuthorGql;
    resolved?: boolean;
    system?: boolean;
    position?: GitLabPositionGql;
}

interface GitLabDiscussionGql {
    id: string;
    notes?: GitLabNoteGql[];
}

interface GitLabRequestContext {
    apiBaseUrl: string;
    sharedToken?: string;
    tokenPromise: Promise<string | undefined> | null;
    bookmarkToCommitId: Map<string, string>;
}

export class GitLabProvider implements CodeForgeProvider {
    public readonly id = 'gitlab';
    public readonly displayName = 'GitLab';
    public readonly changeTerm = 'PR' as const;
    public readonly isAuthManageable = true;

    private cache = new Map<string, CodeForgeChangeInfo>();
    private gitlabHost: string | undefined;
    private projectPath: string | undefined;
    private resolvedProjectPath: string | undefined;
    private allowedProjectIds = new Set<number>();
    private remoteProjectPaths = new Set<string>();
    private forkResolutionPromise: Promise<string> | null = null;
    private forkResolutionPromiseHasToken = false;
    private extensionPromptShown = false;

    private _onDidUpdate = new vscode.EventEmitter<void>();
    public readonly onDidUpdate = this._onDidUpdate.event;

    private hasWarned403 = false;

    constructor(
        private readonly authManager: CodeForgeAuthManager,
        private outputChannel?: JjLoggerChannel,
    ) {
        this.authManager.registerProvider(this.id);
    }

    public async detect(_workspaceRoot: string, remotes: GitRemote[]): Promise<boolean> {
        const preferredHost = vscode.workspace.getConfiguration('jj-view').get<string>('gitlab.host')?.trim();

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

        let host: string | undefined;
        let projectPath: string | undefined;

        for (const remote of prioritized) {
            const parsed = this.parseGitLabUrl(remote.url, preferredHost);
            if (parsed) {
                host = parsed.host;
                projectPath = parsed.projectPath;
                break;
            }
        }

        if (host && projectPath) {
            const projectPaths = new Set<string>();
            for (const remote of remotes) {
                const parsed = this.parseGitLabUrl(remote.url, preferredHost);
                if (parsed) {
                    projectPaths.add(parsed.projectPath);
                }
            }
            if (this.gitlabHost !== host || this.projectPath !== projectPath) {
                this.clearCache();
                this.authManager.setProviderUnavailable(this.id, false);
                this.extensionPromptShown = false;
            }
            this.gitlabHost = host;
            this.projectPath = projectPath;
            this.remoteProjectPaths = projectPaths;
            this.outputChannel?.info(
                `[GitLabProvider] Detected GitLab repo: host=${this.gitlabHost}, projectPath=${this.projectPath}`,
            );
            return true;
        }

        this.gitlabHost = undefined;
        this.projectPath = undefined;
        return false;
    }

    private parseGitLabUrl(url: string, configuredHost?: string): { host: string; projectPath: string } | undefined {
        let cleanUrl = url.trim();
        if (cleanUrl.endsWith('.git')) {
            cleanUrl = cleanUrl.slice(0, -4);
        }

        const match = cleanUrl.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)?([^:/]+)(?::\d+)?[:/](.+)$/);
        if (!match) {
            return undefined;
        }
        const urlHost = match[1].toLowerCase();
        const urlPath = match[2];

        if (configuredHost) {
            try {
                const hostUrl = new URL(configuredHost);
                const expectedHost = hostUrl.hostname.toLowerCase();
                const expectedPathname = hostUrl.pathname.replace(/\/$/, '').toLowerCase();

                if (urlHost === expectedHost) {
                    let normalizedPath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
                    normalizedPath = normalizedPath.replace(/\/$/, '');
                    if (expectedPathname && normalizedPath.toLowerCase().startsWith(expectedPathname)) {
                        normalizedPath = normalizedPath.substring(expectedPathname.length);
                    }

                    if (normalizedPath.startsWith('/')) {
                        normalizedPath = normalizedPath.substring(1);
                    }

                    if (normalizedPath) {
                        return {
                            host: configuredHost.replace(/\/$/, ''),
                            projectPath: normalizedPath,
                        };
                    }
                }
            } catch {
                // Ignore URL parsing errors
            }

            // If configuredHost is set but did not match, only allow public gitlab.com to fall through
            if (urlHost === 'gitlab.com' || urlHost.endsWith('.gitlab.com')) {
                return {
                    host: 'https://gitlab.com',
                    projectPath: urlPath,
                };
            }
            return undefined;
        }

        // Auto-detect gitlab URLs if no configured host is specified
        if (urlHost.includes('gitlab')) {
            return {
                host: `https://${match[1]}`,
                projectPath: urlPath,
            };
        }

        return undefined;
    }

    private async promptInstallGitLabExtension(): Promise<void> {
        const installAction = 'Install Extension';
        const patAction = 'Enter Personal Access Token (PAT)';
        const choice = await vscode.window.showWarningMessage(
            `GitLab repository '${this.projectPath}' appears to be private or requires authentication, but the GitLab authentication provider is not installed.`,
            installAction,
            patAction,
        );

        if (choice === installAction) {
            vscode.commands.executeCommand('workbench.extensions.search', GITLAB_EXTENSION_ID);
        } else if (choice === patAction) {
            await this.promptForPat();
        }
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
        if (!this.gitlabHost || !this.projectPath || changes.length === 0) {
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
        const BATCH_SIZE = 10;
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
                this.outputChannel?.error(`[GitLabProvider] Failed to fetch statuses for batch: ${error}`);
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
        const projectPath = this.projectPath;
        if (!this.gitlabHost || !projectPath || bookmarkNames.length === 0) {
            return results;
        }

        const sharedToken = await this.getSessionToken(false);
        const apiBaseUrl = process.env.JJ_VIEW_GITLAB_API_URL || `${this.gitlabHost}/api/v4`;

        // Resolve upstream project path once if fork
        if (!this.resolvedProjectPath) {
            await this.resolveForkPath(apiBaseUrl, sharedToken);
        }

        const context: GitLabRequestContext = {
            apiBaseUrl,
            sharedToken,
            tokenPromise: null,
            bookmarkToCommitId,
        };

        const fetchBookmarkWrapper = async (bookmark: string): Promise<void> => {
            const info = await this.fetchBookmark(bookmark, context);
            if (info) {
                results.set(bookmark, info);
            }
        };

        await Promise.all(bookmarkNames.map((bookmark) => fetchBookmarkWrapper(bookmark)));
        return results;
    }

    private async fetchBookmark(
        bookmark: string,
        context: GitLabRequestContext,
    ): Promise<CodeForgeChangeInfo | undefined> {
        const projectPath = this.projectPath;
        if (!projectPath) {
            return undefined;
        }

        const acquireToken = async (): Promise<string | undefined> => {
            if (context.sharedToken) {
                return context.sharedToken;
            }
            if (!context.tokenPromise) {
                context.tokenPromise = (async () => {
                    const promptToken = await this.getSessionToken(true);
                    if (promptToken) {
                        context.sharedToken = promptToken;
                    }
                    return promptToken;
                })();
            }
            return context.tokenPromise;
        };

        const getUrl = (path: string) =>
            `${context.apiBaseUrl}/projects/${encodeURIComponent(path)}/merge_requests?source_branch=${encodeURIComponent(bookmark)}&with_merge_status_recheck=true`;

        try {
            let currentPath = this.resolvedProjectPath || projectPath;
            let response = await fetchWithTimeout(getUrl(currentPath), 15000, {
                headers: this.getHeaders(context.sharedToken),
            });

            const retryResult = await this.tryUnauthenticatedRetry(
                response,
                currentPath,
                getUrl,
                context,
                acquireToken,
            );
            response = retryResult.response;
            currentPath = retryResult.currentPath;

            await this.handleInvalidTokenIfNeeded(response.status, context);

            if (!response.ok) {
                this.outputChannel?.error(
                    `[GitLabProvider] Request failed with status ${response.status}: ${response.statusText}`,
                );
                this.handle403Warning(response);
                return undefined;
            }

            const parsedJson = await response.json();
            const validation = GitLabMergeRequestSchema.array().safeParse(parsedJson);
            if (!validation.success) {
                this.outputChannel?.error(
                    `[GitLabProvider] Failed to validate MR array response: ${validation.error.message}`,
                );
                return undefined;
            }

            const mrs = validation.data;
            if (Array.isArray(mrs) && mrs.length > 0) {
                const filteredMrs = this.filterGitLabMrs(mrs, bookmark, context.bookmarkToCommitId);
                if (filteredMrs.length > 0) {
                    const openMr = filteredMrs.find((mr) => mr.state === 'opened');
                    const selectedMr = openMr || filteredMrs[0];

                    const detailedMr = await this.fetchSingleMrDetails(
                        context.apiBaseUrl,
                        currentPath,
                        selectedMr,
                        context.sharedToken,
                    );

                    return this.parseGitLabMr(detailedMr);
                }
            }
        } catch (error) {
            this.outputChannel?.error(`[GitLabProvider] Failed to fetch MR for bookmark ${bookmark}: ${error}`);
        }
        return undefined;
    }

    private async tryUnauthenticatedRetry(
        response: Response,
        currentPath: string,
        getUrl: (path: string) => string,
        context: GitLabRequestContext,
        acquireToken: () => Promise<string | undefined>,
    ): Promise<{ response: Response; currentPath: string }> {
        if ((response.status === 401 || response.status === 404) && !context.sharedToken) {
            if (this.authManager.isProviderUnavailable(this.id)) {
                if (!this.extensionPromptShown) {
                    this.extensionPromptShown = true;
                    this.promptInstallGitLabExtension();
                }
            } else {
                this.outputChannel?.error(
                    `[GitLabProvider] Unauthenticated request failed with status ${response.status}. Prompting for GitLab OAuth...`,
                );
                const promptToken = await acquireToken();
                if (promptToken) {
                    const resolvedPath = await this.resolveForkPath(context.apiBaseUrl, promptToken);
                    const retriedResponse = await fetchWithTimeout(getUrl(resolvedPath), 15000, {
                        headers: this.getHeaders(promptToken),
                    });
                    return { response: retriedResponse, currentPath: resolvedPath };
                }
            }
        }
        return { response, currentPath };
    }

    private async handleInvalidTokenIfNeeded(status: number, context: GitLabRequestContext): Promise<void> {
        const currentToken = context.sharedToken;
        if (status === 401 && currentToken) {
            this.outputChannel?.error(
                `[GitLabProvider] Request failed with 401 Unauthorized using token. Stored token may be invalid or expired.`,
            );
            // Reset the in-memory token cache so the next request re-fetches credentials.
            if (context.sharedToken === currentToken) {
                context.sharedToken = undefined;
                context.tokenPromise = null;
            }
            await this.authManager.clearInvalidToken({
                providerId: 'gitlab',
                secretTokenKey: 'gitlab_token',
                currentToken,
                envTokenKey: 'JJ_VIEW_GITLAB_TOKEN',
            });
        }
    }

    private filterGitLabMrs(
        mrs: GitLabMergeRequest[],
        bookmark: string,
        bookmarkToCommitId: Map<string, string>,
    ): GitLabMergeRequest[] {
        return mrs.filter((mr) => {
            const sourceId = mr.source_project_id;
            if (sourceId) {
                return this.allowedProjectIds.size === 0 || this.allowedProjectIds.has(sourceId);
            }
            const localCommitId = bookmarkToCommitId.get(bookmark);
            if (localCommitId && mr.sha) {
                return mr.sha === localCommitId;
            }
            return false;
        });
    }

    private async fetchSingleMrDetails(
        apiBaseUrl: string,
        projectPath: string,
        selectedMr: GitLabMergeRequest,
        token: string | undefined,
    ): Promise<GitLabMergeRequest> {
        const singleMrUrl = `${apiBaseUrl}/projects/${encodeURIComponent(projectPath)}/merge_requests/${selectedMr.iid}`;
        try {
            const response = await fetchWithTimeout(singleMrUrl, 15000, {
                headers: this.getHeaders(token),
            });
            if (response.ok) {
                const parsedJson = await response.json();
                const validation = GitLabMergeRequestSchema.safeParse(parsedJson);
                if (validation.success) {
                    return validation.data;
                }
                this.outputChannel?.error(
                    `[GitLabProvider] Failed to validate single MR detail: ${validation.error.message}`,
                );
                return selectedMr;
            }
            this.outputChannel?.error(
                `[GitLabProvider] Failed to fetch single MR detail with status ${response.status}, falling back to list MR data`,
            );
            this.handle403Warning(response);
        } catch (err) {
            this.outputChannel?.error(
                `[GitLabProvider] Error fetching single MR detail: ${err}, falling back to list MR data`,
            );
        }
        return selectedMr;
    }

    private getHeaders(token: string | undefined): Record<string, string> {
        const headers: Record<string, string> = {
            'User-Agent': 'jj-view-vscode-extension',
        };
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        return headers;
    }

    private async resolveForkPath(apiBaseUrl: string, token: string | undefined): Promise<string> {
        const projectPath = this.projectPath;
        if (!projectPath) {
            return '';
        }
        if (this.resolvedProjectPath) {
            return this.resolvedProjectPath;
        }
        if (this.forkResolutionPromise && (this.forkResolutionPromiseHasToken || !token)) {
            return this.forkResolutionPromise;
        }
        this.forkResolutionPromiseHasToken = !!token;
        this.forkResolutionPromise = (async () => {
            // First resolve project IDs for all configured remote project paths
            for (const path of this.remoteProjectPaths) {
                if (path === projectPath) {
                    continue;
                }
                const projectInfo = await this.fetchProjectInfo(apiBaseUrl, path, token);
                if (projectInfo) {
                    if (projectInfo.id) {
                        this.allowedProjectIds.add(projectInfo.id);
                    }
                    if (projectInfo.forked_from_project?.id) {
                        this.allowedProjectIds.add(projectInfo.forked_from_project.id);
                    }
                }
            }

            const projectInfo = await this.fetchProjectInfo(apiBaseUrl, projectPath, token);
            if (projectInfo) {
                if (projectInfo.id) {
                    this.allowedProjectIds.add(projectInfo.id);
                }
                if (projectInfo.forked_from_project?.id) {
                    this.allowedProjectIds.add(projectInfo.forked_from_project.id);
                }
                if (projectInfo.forked_from_project?.path_with_namespace) {
                    this.resolvedProjectPath = projectInfo.forked_from_project.path_with_namespace;
                    this.outputChannel?.info(
                        `[GitLabProvider] Detected parent project for fork: ${this.resolvedProjectPath}`,
                    );
                } else {
                    // Mark as resolved (none) so we don't query again
                    this.resolvedProjectPath = projectPath;
                }
            }
            this.forkResolutionPromise = null;
            this.forkResolutionPromiseHasToken = false;
            return this.resolvedProjectPath || projectPath;
        })();
        return this.forkResolutionPromise;
    }

    private async fetchProjectInfo(
        apiBaseUrl: string,
        path: string,
        token: string | undefined,
    ): Promise<
        | {
              id?: number;
              forked_from_project?: {
                  id?: number;
                  path_with_namespace?: string;
              };
          }
        | undefined
    > {
        try {
            const projectUrl = `${apiBaseUrl}/projects/${encodeURIComponent(path)}`;
            const response = await fetchWithTimeout(projectUrl, 10000, {
                headers: this.getHeaders(token),
            });
            if (response.ok) {
                const parsedJson = await response.json();
                const validation = GitLabProjectInfoSchema.safeParse(parsedJson);
                if (validation.success) {
                    return validation.data;
                }
                this.outputChannel?.error(
                    `[GitLabProvider] Failed to validate project info: ${validation.error.message}`,
                );
                return undefined;
            }
        } catch (e) {
            this.outputChannel?.error(`[GitLabProvider] Failed to fetch project details for ${path}: ${e}`);
        }
        return undefined;
    }

    private parseGitLabMr(mr: GitLabMergeRequest): CodeForgeChangeInfo | undefined {
        const stateMap: Record<string, 'NEW' | 'MERGED' | 'ABANDONED'> = {
            opened: 'NEW',
            merged: 'MERGED',
            closed: 'ABANDONED',
            locked: 'ABANDONED',
        };

        const isDraft = mr.draft === true || mr.work_in_progress === true;
        const hasConflicts =
            mr.has_conflicts === true ||
            mr.merge_status === 'cannot_be_merged' ||
            mr.detailed_merge_status === 'conflict';
        const hasUnresolvedDiscussions =
            mr.blocking_discussions_resolved === false || mr.detailed_merge_status === 'discussions_not_resolved';

        // Treat it as mergeable if detailed_merge_status is explicitly 'mergeable'
        // or (if detailed_merge_status is absent/empty) if merge_status is 'can_be_merged'.
        const isMergeable = mr.detailed_merge_status
            ? mr.detailed_merge_status === 'mergeable'
            : mr.merge_status === 'can_be_merged';

        const submittable = !isDraft && !hasConflicts && !hasUnresolvedDiscussions && isMergeable;

        const unresolvedComments =
            mr.blocking_discussions_resolved === false || mr.detailed_merge_status === 'discussions_not_resolved'
                ? mr.user_notes_count || 1
                : 0;

        return {
            id: mr.id.toString(),
            number: mr.iid,
            displayLabel: `MR !${mr.iid}`,
            providerName: 'GitLab',
            status: stateMap[mr.state] || 'NEW',
            submittable,
            url: mr.web_url,
            unresolvedComments,
            currentRevision: mr.sha,
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

    private handle403Warning(response: Response) {
        if (response.status === 403 && !this.hasWarned403) {
            this.hasWarned403 = true;
            const oauthScopes = response.headers.get('x-oauth-scopes');
            if (oauthScopes) {
                const scopes = oauthScopes.split(',').map((s) => s.trim().toLowerCase());
                const hasRequired = scopes.some((s) => s === 'api' || s === 'read_api' || s.includes('merge_request'));
                if (!hasRequired) {
                    vscode.window.showWarningMessage(
                        `GitLab request failed (403 Forbidden). The provided token has scopes [${oauthScopes}] but requires 'Merge Request' read/write permissions or 'api' scope.`,
                    );
                }
            } else {
                vscode.window.showWarningMessage(
                    `GitLab request failed (403 Forbidden). Please check that your token has 'Merge Request' read/write permissions or 'api' scope.`,
                );
            }
        }
    }

    public async getCommentThreads(changeId: string, signal?: AbortSignal): Promise<CodeForgeCommentThread[]> {
        const changeInfo = Array.from(this.cache.values()).find((info) => info.id === changeId);
        if (!changeInfo) {
            return [];
        }
        const token = await this.getSessionToken(false);
        const { projectPath } = this;
        if (!this.gitlabHost || !projectPath) {
            return [];
        }

        const apiBaseUrl = process.env.JJ_VIEW_GITLAB_API_URL || `${this.gitlabHost}/api/v4`;
        const url = `${apiBaseUrl}/projects/${encodeURIComponent(projectPath)}/merge_requests/${changeInfo.number}/discussions?per_page=100`;

        const response = await fetchWithTimeout(url, 15000, {
            headers: {
                'Private-Token': token || '',
                'User-Agent': 'jj-view-vscode-extension',
            },
            signal,
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch GitLab discussions: ${response.statusText}`);
        }

        const rawDiscussions = (await response.json()) as GitLabDiscussionGql[];
        const threads: CodeForgeCommentThread[] = [];

        for (const disc of rawDiscussions) {
            const notes = (disc.notes || []).filter((n) => !n.system);
            if (notes.length === 0) {
                continue;
            }

            const firstNote = notes[0];
            const comments: CodeForgeComment[] = notes.map((n) => ({
                id: n.id.toString(),
                author: {
                    name: n.author?.name || 'Unknown',
                    username: n.author?.username,
                    avatarUrl: n.author?.avatar_url,
                },
                body: n.body,
                createdAt: n.created_at,
            }));

            threads.push({
                id: disc.id,
                filePath: firstNote.position?.new_path || undefined,
                line: firstNote.position?.new_line || undefined,
                isResolved: notes.every((n) => n.resolved !== false),
                comments,
            });
        }

        return threads;
    }

    public async replyToCommentThread(
        changeId: string,
        threadId: string,
        body: string,
        resolved?: boolean,
    ): Promise<CodeForgeComment> {
        const changeInfo = Array.from(this.cache.values()).find((info) => info.id === changeId);
        if (!changeInfo) {
            throw new Error('Change not found in cache');
        }
        const token = await this.getSessionToken(false);
        const projectPath = this.projectPath;
        if (!this.gitlabHost || !projectPath) {
            throw new Error('GitLab provider not fully configured');
        }

        const apiBaseUrl = process.env.JJ_VIEW_GITLAB_API_URL || `${this.gitlabHost}/api/v4`;
        const url = `${apiBaseUrl}/projects/${encodeURIComponent(projectPath)}/merge_requests/${changeInfo.number}/discussions/${threadId}/notes`;

        const response = await fetchWithTimeout(url, 15000, {
            method: 'POST',
            headers: {
                'Private-Token': token || '',
                'Content-Type': 'application/json',
                'User-Agent': 'jj-view-vscode-extension',
            },
            body: JSON.stringify({ body }),
        });

        if (!response.ok) {
            throw new Error(`Failed to post GitLab reply: ${response.statusText}`);
        }

        const note = (await response.json()) as GitLabNoteGql;

        if (resolved !== undefined) {
            await this.resolveCommentThread(changeId, threadId, resolved);
        }

        return {
            id: note.id.toString(),
            author: {
                name: note.author?.name || 'Unknown',
                username: note.author?.username,
                avatarUrl: note.author?.avatar_url,
            },
            body: note.body,
            createdAt: note.created_at,
        };
    }

    public async resolveCommentThread(changeId: string, threadId: string, resolved: boolean): Promise<void> {
        const changeInfo = Array.from(this.cache.values()).find((info) => info.id === changeId);
        if (!changeInfo) {
            throw new Error('Change not found in cache');
        }
        const token = await this.getSessionToken(false);
        const projectPath = this.projectPath;
        if (!this.gitlabHost || !projectPath) {
            throw new Error('GitLab provider not fully configured');
        }

        const apiBaseUrl = process.env.JJ_VIEW_GITLAB_API_URL || `${this.gitlabHost}/api/v4`;
        const url = `${apiBaseUrl}/projects/${encodeURIComponent(projectPath)}/merge_requests/${changeInfo.number}/discussions/${threadId}`;

        const response = await fetchWithTimeout(`${url}?resolved=${resolved}`, 15000, {
            method: 'PUT',
            headers: {
                'Private-Token': token || '',
                'User-Agent': 'jj-view-vscode-extension',
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to toggle resolved status: ${response.statusText}`);
        }
    }

    public clearCache(): void {
        this.cache.clear();
        this.resolvedProjectPath = undefined;
        this.allowedProjectIds.clear();
        this.remoteProjectPaths.clear();
        this.forkResolutionPromise = null;
        this.forkResolutionPromiseHasToken = false;
        this.hasWarned403 = false;
        this._onDidUpdate.fire();
    }

    public activate(): void {
        this.authManager.setProviderUnavailable(this.id, false);
        this.extensionPromptShown = false;
        this.hasWarned403 = false;
        this.outputChannel?.info('[GitLabProvider] Activated');
    }

    public deactivate(): void {
        this.outputChannel?.info('[GitLabProvider] Deactivated');
    }

    private async getSessionToken(prompt = false): Promise<string | undefined> {
        return this.authManager.getSessionToken(this.id, {
            scopes: ['api'],
            envTokenKey: 'JJ_VIEW_GITLAB_TOKEN',
            secretTokenKey: 'gitlab_token',
            promptMessage: `GitLab authentication is required to fetch MR status for '${this.projectPath}'.`,
            signInLabel: 'Sign In (OAuth)',
            prompt,
            alternativeChoice: {
                label: 'Enter PAT',
                execute: () => this.promptForPat(),
            },
            shouldSkipPrompt: () => {
                const hasGitLabExtension = !!vscode.extensions.getExtension(GITLAB_EXTENSION_ID);
                return this.authManager.isProviderUnavailable(this.id) && !hasGitLabExtension;
            },
            extensionInstaller: {
                extensionId: GITLAB_EXTENSION_ID,
                extensionName: 'GitLab Workflow',
                providerName: 'GitLab',
            },
        });
    }

    public async promptForPat(): Promise<AuthResult> {
        return this.authManager.promptForPat({
            providerId: this.id,
            displayName: this.displayName,
            secretTokenKey: 'gitlab_token',
            prompt: "Enter your GitLab Personal Access Token (PAT). Requires 'Merge Request' read/write permissions or 'api' scope.",
            placeHolder: 'glpat-...',
            clearCache: () => this.clearCache(),
        });
    }

    public async hasAuth(): Promise<boolean> {
        if (process.env.JJ_VIEW_GITLAB_TOKEN) {
            return true;
        }
        try {
            const storedToken = await this.authManager.secrets.get('gitlab_token');
            if (storedToken) {
                return true;
            }
        } catch {}
        return this.authManager.hasOAuthSession(this.id, ['api']);
    }

    public async getAuthManageItems(): Promise<AuthManageItem[]> {
        return this.authManager.getAuthManageItems(this.id, {
            displayName: this.displayName,
            scopes: ['api'],
            envTokenKey: 'JJ_VIEW_GITLAB_TOKEN',
            secretTokenKey: 'gitlab_token',
            hasAuth: () => this.hasAuth(),
            clearCache: () => this.clearCache(),
            promptForPat: () => this.promptForPat(),
            extensionInstaller: {
                extensionId: GITLAB_EXTENSION_ID,
                extensionName: 'GitLab Workflow',
                providerName: 'GitLab',
            },
        });
    }
}
