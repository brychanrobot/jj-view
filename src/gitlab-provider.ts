/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { ChangeStatusRequest, CodeForgeProvider, GitRemote } from './code-forge-provider';
import type { CodeForgeChangeInfo } from './jj-types';
import { chunkArray } from './utils/array-utils';
import { fetchWithTimeout } from './utils/fetch-utils';

interface GitLabMergeRequest {
    id: number;
    iid: number;
    state: string;
    draft?: boolean;
    work_in_progress?: boolean;
    has_conflicts?: boolean;
    merge_status?: string;
    detailed_merge_status?: string;
    blocking_discussions_resolved?: boolean;
    user_notes_count?: number;
    web_url: string;
    sha: string;
}

export class GitLabProvider implements CodeForgeProvider {
    public readonly id = 'gitlab';
    public readonly displayName = 'GitLab';
    public readonly changeTerm = 'PR' as const;

    private cache = new Map<string, CodeForgeChangeInfo>();
    private gitlabHost: string | undefined;
    private projectPath: string | undefined;
    private tokenRequested = false;
    private gitlabAuthUnavailable = false;
    private extensionPromptShown = false;

    private _onDidUpdate = new vscode.EventEmitter<void>();
    public readonly onDidUpdate = this._onDidUpdate.event;

    constructor(
        private outputChannel?: vscode.OutputChannel,
        private secrets?: vscode.SecretStorage,
    ) {}

    public async detect(_workspaceRoot: string, remotes: GitRemote[]): Promise<boolean> {
        const preferredHost = vscode.workspace.getConfiguration('jj-view').get<string>('gitlab.host')?.trim();

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
            if (this.gitlabHost !== host || this.projectPath !== projectPath) {
                this.clearCache();
                this.gitlabAuthUnavailable = false;
                this.extensionPromptShown = false;
            }
            this.gitlabHost = host;
            this.projectPath = projectPath;
            this.outputChannel?.appendLine(
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

    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, rejectReason: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(rejectReason)), timeoutMs);
        });
        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    private async getSessionToken(prompt = false): Promise<string | undefined> {
        if (process.env.JJ_VIEW_GITLAB_TOKEN) {
            return process.env.JJ_VIEW_GITLAB_TOKEN;
        }

        if (this.secrets) {
            try {
                const storedToken = await this.secrets.get('gitlab_token');
                if (storedToken) {
                    return storedToken;
                }
            } catch (err) {
                this.outputChannel?.appendLine(`[GitLabProvider] Failed to read token from secrets: ${err}`);
            }
        }

        // Check if GitLab extension is installed or if we already verified provider is available
        const hasGitLabExtension = !!vscode.extensions.getExtension('GitLab.gitlab-workflow');
        if (this.gitlabAuthUnavailable && !hasGitLabExtension) {
            return undefined;
        }

        try {
            if (prompt) {
                if (this.tokenRequested) {
                    return undefined;
                }
                this.tokenRequested = true;
                const session = await vscode.authentication.getSession('gitlab', ['read_api'], { createIfNone: true });
                return session?.accessToken;
            } else {
                // Try silently first with a short timeout to check if provider exists
                const silentPromise = Promise.resolve(
                    vscode.authentication.getSession('gitlab', ['read_api'], { silent: true }),
                );
                const session = await this.withTimeout(
                    silentPromise,
                    1000,
                    'GitLab authentication provider not registered or timed out',
                );
                this.gitlabAuthUnavailable = false;
                return session?.accessToken;
            }
        } catch (e) {
            const errorStr = String(e);
            const isUnregistered =
                errorStr.includes('not registered') ||
                errorStr.includes('Timed out waiting') ||
                errorStr.includes('No authentication provider');

            if (isUnregistered) {
                this.gitlabAuthUnavailable = true;
                this.outputChannel?.appendLine(
                    `[GitLabProvider] GitLab authentication provider is not available in VS Code. Using unauthenticated requests only.`,
                );
            } else {
                this.outputChannel?.appendLine(`[GitLabProvider] Failed to get OAuth token: ${errorStr}`);
            }
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
            vscode.commands.executeCommand('workbench.extensions.search', 'GitLab.gitlab-workflow');
        } else if (choice === patAction) {
            await this.promptForPat();
        }
    }

    private async promptForPat(): Promise<void> {
        const token = await vscode.window.showInputBox({
            prompt: 'Enter your GitLab Personal Access Token (PAT)',
            placeHolder: 'glpat-...',
            password: true,
            ignoreFocusOut: true,
        });

        if (token?.trim()) {
            if (this.secrets) {
                await this.secrets.store('gitlab_token', token.trim());
                this.outputChannel?.appendLine('[GitLabProvider] Personal Access Token saved successfully');
                this.clearCache();
            } else {
                this.outputChannel?.appendLine('[GitLabProvider] Secrets storage is not available to save PAT');
            }
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

    public async fetchStatuses(changes: ChangeStatusRequest[]): Promise<boolean> {
        if (!this.gitlabHost || !this.projectPath || changes.length === 0) {
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
        const BATCH_SIZE = 10;
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
                this.outputChannel?.appendLine(`[GitLabProvider] Failed to fetch statuses for batch: ${error}`);
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
        const projectPath = this.projectPath;
        if (!this.gitlabHost || !projectPath || bookmarkNames.length === 0) {
            return results;
        }

        let sharedToken = await this.getSessionToken(false);
        let tokenPromise: Promise<string | undefined> | null = null;

        const acquireToken = async (): Promise<string | undefined> => {
            if (sharedToken) {
                return sharedToken;
            }
            if (!tokenPromise) {
                tokenPromise = (async () => {
                    const promptToken = await this.getSessionToken(true);
                    if (promptToken) {
                        sharedToken = promptToken;
                    }
                    return promptToken;
                })();
            }
            return tokenPromise;
        };

        const getHeaders = (t: string | undefined): Record<string, string> => {
            const h: Record<string, string> = {
                'User-Agent': 'jj-view-vscode-extension',
            };
            if (t) {
                h.Authorization = `Bearer ${t}`;
            }
            return h;
        };

        const apiBaseUrl = process.env.JJ_VIEW_GITLAB_API_URL || `${this.gitlabHost}/api/v4`;

        const fetchBookmark = async (bookmark: string): Promise<void> => {
            const urlStr = `${apiBaseUrl}/projects/${encodeURIComponent(projectPath)}/merge_requests?source_branch=${encodeURIComponent(bookmark)}&with_merge_status_recheck=true`;

            try {
                let response = await fetchWithTimeout(urlStr, 15000, { headers: getHeaders(sharedToken) });

                if ((response.status === 401 || response.status === 404) && !sharedToken) {
                    if (this.gitlabAuthUnavailable) {
                        if (!this.extensionPromptShown) {
                            this.extensionPromptShown = true;
                            this.promptInstallGitLabExtension();
                        }
                    } else {
                        this.outputChannel?.appendLine(
                            `[GitLabProvider] Unauthenticated request failed with status ${response.status}. Prompting for GitLab OAuth...`,
                        );
                        const promptToken = await acquireToken();
                        if (promptToken) {
                            response = await fetchWithTimeout(urlStr, 15000, { headers: getHeaders(promptToken) });
                        }
                    }
                }

                const currentToken = sharedToken;
                if (response.status === 401 && currentToken) {
                    this.outputChannel?.appendLine(
                        `[GitLabProvider] Request failed with 401 Unauthorized using token. Stored token may be invalid or expired.`,
                    );
                    if (sharedToken === currentToken) {
                        sharedToken = undefined;
                        tokenPromise = null;
                    }
                    if (this.secrets && !process.env.JJ_VIEW_GITLAB_TOKEN) {
                        try {
                            const storedToken = await this.secrets.get('gitlab_token');
                            if (storedToken === currentToken) {
                                this.outputChannel?.appendLine(`[GitLabProvider] Clearing invalid stored PAT...`);
                                await this.secrets.delete('gitlab_token');
                            }
                        } catch (err) {
                            this.outputChannel?.appendLine(`[GitLabProvider] Failed to delete token: ${err}`);
                        }
                    }
                }

                if (!response.ok) {
                    this.outputChannel?.appendLine(
                        `[GitLabProvider] Request failed with status ${response.status}: ${response.statusText}`,
                    );
                    return;
                }

                const mrs = (await response.json()) as GitLabMergeRequest[];
                if (Array.isArray(mrs) && mrs.length > 0) {
                    const openMr = mrs.find((mr) => mr.state === 'opened');
                    const selectedMr = openMr || mrs[0];

                    let detailedMr = selectedMr;
                    const singleMrUrl = `${apiBaseUrl}/projects/${encodeURIComponent(projectPath)}/merge_requests/${selectedMr.iid}`;
                    try {
                        const singleResponse = await fetchWithTimeout(singleMrUrl, 15000, {
                            headers: getHeaders(sharedToken),
                        });
                        if (singleResponse.ok) {
                            detailedMr = (await singleResponse.json()) as GitLabMergeRequest;
                        } else {
                            this.outputChannel?.appendLine(
                                `[GitLabProvider] Failed to fetch single MR detail with status ${singleResponse.status}, falling back to list MR data`,
                            );
                        }
                    } catch (singleErr) {
                        this.outputChannel?.appendLine(
                            `[GitLabProvider] Error fetching single MR detail: ${singleErr}, falling back to list MR data`,
                        );
                    }

                    const info = this.parseGitLabMr(detailedMr);
                    if (info) {
                        results.set(bookmark, info);
                    }
                }
            } catch (error) {
                this.outputChannel?.appendLine(
                    `[GitLabProvider] Failed to fetch MR for bookmark ${bookmark}: ${error}`,
                );
            }
        };

        await Promise.all(bookmarkNames.map((bookmark) => fetchBookmark(bookmark)));
        return results;
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

    public clearCache(): void {
        this.cache.clear();
        this.tokenRequested = false;
        this._onDidUpdate.fire();
    }

    public activate(): void {
        this.tokenRequested = false;
        this.gitlabAuthUnavailable = false;
        this.extensionPromptShown = false;
        this.outputChannel?.appendLine('[GitLabProvider] Activated');
    }

    public deactivate(): void {
        this.outputChannel?.appendLine('[GitLabProvider] Deactivated');
    }
}
