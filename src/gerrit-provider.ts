/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import { z } from 'zod';
import type {
    ChangeStatusRequest,
    CodeForgeComment,
    CodeForgeCommentThread,
    CodeForgeProvider,
    GitRemote,
} from './code-forge-provider';
import type { JjService } from './jj-service';
import type { CodeForgeChangeInfo } from './jj-types';
import { chunkArray } from './utils/array-utils';
import { fetchWithTimeout } from './utils/fetch-utils';
import { getGerritAuthHeader, resolveGitRoot } from './utils/gerrit-credential-utils';
import { detectGerritHost } from './utils/gerrit-host-detection';
import { resolveGerritChangeKey, stripGerritTrailers } from './utils/gerrit-utils';
import { convertJjChangeIdToHex } from './utils/jj-utils';
import type { JjLoggerChannel } from './utils/output-channel';

export const GerritFileSchema = z.object({
    status: z.string().optional(),
    new_sha: z.string().optional(),
});
export type GerritFile = z.infer<typeof GerritFileSchema>;

export const GerritRevisionSchema = z.object({
    files: z.record(z.string(), GerritFileSchema).optional(),
    commit: z
        .object({
            message: z.string(),
            parents: z.array(z.object({ commit: z.string() })).optional(),
        })
        .optional(),
});
export type GerritRevision = z.infer<typeof GerritRevisionSchema>;

export const GerritChangeSchema = z.object({
    change_id: z.string(),
    _number: z.number(),
    status: z.enum(['NEW', 'MERGED', 'ABANDONED']),
    submittable: z.boolean(),
    unresolved_comment_count: z.number().optional(),
    current_revision: z.string().optional(),
    revisions: z.record(z.string(), GerritRevisionSchema).optional(),
    project: z.string().optional(),
    branch: z.string().optional(),
    subject: z.string().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    mergeable: z.boolean().optional(),
    insertions: z.number().optional(),
    deletions: z.number().optional(),
    owner: z.object({ _account_id: z.number() }).optional(),
    labels: z.record(z.string(), z.unknown()).optional(),
});
export type GerritChange = z.infer<typeof GerritChangeSchema>;

interface GerritAuthorGql {
    name?: string;
    username?: string;
    email?: string;
}

interface GerritCommentGql {
    id: string;
    line?: number;
    message?: string;
    updated: string;
    author?: GerritAuthorGql;
    unresolved?: boolean;
    in_reply_to?: string;
}

interface FetchGerritOptions extends RequestInit {
    timeoutMs?: number;
}

export class GerritProvider implements CodeForgeProvider {
    public readonly id = 'gerrit';
    public readonly displayName = 'Gerrit';
    public readonly changeTerm = 'CL' as const;

    private cache = new Map<string, CodeForgeChangeInfo>();
    private gerritHost: string | undefined;
    private repoRoot: string | undefined;
    private gitRoot: string | null = null;
    private authHeader: { name: string; value: string } | undefined;
    private authChecked = false;

    private _onDidUpdate = new vscode.EventEmitter<void>();
    public readonly onDidUpdate = this._onDidUpdate.event;

    constructor(private outputChannel?: JjLoggerChannel) {}

    public async detect(repoRoot: string, remotes: GitRemote[]): Promise<boolean> {
        const binaryPath = vscode.workspace.getConfiguration('jj-view').get<string>('binaryPath') || 'jj';
        const gitRoot = await resolveGitRoot(repoRoot, binaryPath);

        if (this.repoRoot !== repoRoot) {
            this.clearCache();
            this.repoRoot = repoRoot;
            this.gitRoot = gitRoot;
        } else if (gitRoot !== null) {
            if (this.gitRoot !== gitRoot) {
                this.clearCache();
            }
            this.gitRoot = gitRoot;
        }

        const host = await detectGerritHost(
            repoRoot,
            this.gitRoot,
            remotes,
            (h: string) => this.probeGerritHost(h),
            this.outputChannel,
        );

        if (host) {
            if (this.gerritHost !== host) {
                this.clearCache();
            }
            this.gerritHost = host;
            return true;
        }

        this.gerritHost = undefined;
        return false;
    }

    private async probeGerritHost(host: string): Promise<boolean> {
        try {
            const response = await fetchWithTimeout(`${host}/config/server/version`, 3000);
            return response.ok;
        } catch (e) {
            this.outputChannel?.error(`[GerritProvider] Probe error for host ${host}: ${e}`);
            return false;
        }
    }

    private async getAuthHeader(): Promise<{ name: string; value: string } | undefined> {
        if (!this.gerritHost || !this.repoRoot) {
            return undefined;
        }
        if (this.authChecked) {
            return this.authHeader;
        }
        this.authChecked = true;
        this.authHeader = await getGerritAuthHeader(this.gerritHost, this.gitRoot, this.outputChannel);
        return this.authHeader;
    }

    private async fetchGerrit(url: string, options?: FetchGerritOptions): Promise<Response> {
        const auth = await this.getAuthHeader();
        let finalUrl = url;
        const headers = new Headers(options?.headers);

        if (auth) {
            headers.set(auth.name, auth.value);
            // Rewrite /changes/ to /a/changes/ to force Gerrit to authenticate
            try {
                const parsedUrl = new URL(url);
                if (parsedUrl.pathname.startsWith('/changes/') && !parsedUrl.pathname.startsWith('/a/')) {
                    parsedUrl.pathname = `/a${parsedUrl.pathname}`;
                    finalUrl = parsedUrl.toString();
                }
            } catch {
                // Handle relative URL (e.g. '/changes/...')
                if (url.startsWith('/changes/') && !url.startsWith('/a/')) {
                    finalUrl = `/a${url}`;
                }
            }
        }

        const timeout = options?.timeoutMs ?? 15000;
        this.outputChannel?.debug(`[GerritProvider] fetchGerrit: ${finalUrl} (auth: ${!!auth})`);
        return fetchWithTimeout(finalUrl, timeout, { ...options, headers });
    }

    public getCachedChangeInfo(
        changeId?: string,
        description?: string,
        _bookmarks?: string[],
    ): CodeForgeChangeInfo | undefined {
        if (!this.gerritHost) {
            return undefined;
        }

        const cacheKey = this.resolveCacheKey(changeId, description);
        if (cacheKey && this.cache.has(cacheKey)) {
            const info = this.cache.get(cacheKey);
            return info ? { ...info } : undefined;
        }

        return undefined;
    }

    private resolveCacheKey(changeId?: string, description?: string): string | undefined {
        if (changeId?.startsWith('I')) {
            return changeId;
        }

        if (description) {
            const parsed = resolveGerritChangeKey(description, this.gerritHost);
            if (parsed) {
                return parsed;
            }
        }

        if (changeId) {
            const baseId = changeId.split('/')[0];
            const isJjChangeId = /^[k-z]+$/.test(baseId);
            if (isJjChangeId) {
                try {
                    const hexId = convertJjChangeIdToHex(changeId);
                    return `I${hexId}`;
                } catch (e) {
                    this.outputChannel?.error(`[GerritProvider] Failed to convert JJ Change-Id: ${e}`);
                }
            }
        }
        return undefined;
    }

    public async fetchStatuses(changes: ChangeStatusRequest[], jj: JjService): Promise<boolean> {
        if (!this.gerritHost || changes.length === 0) {
            return false;
        }

        const cacheKeysToFetch = new Set<string>();
        const changesByCacheKey = new Map<string, (typeof changes)[0][]>();

        for (const change of changes) {
            const cacheKey = this.resolveCacheKey(change.changeId, change.description);
            if (cacheKey) {
                cacheKeysToFetch.add(cacheKey);
                const list = changesByCacheKey.get(cacheKey) || [];
                list.push(change);
                changesByCacheKey.set(cacheKey, list);
            }
        }

        if (cacheKeysToFetch.size === 0) {
            return false;
        }

        const cacheKeysArray = Array.from(cacheKeysToFetch);
        const BATCH_SIZE = 10;
        const cacheKeyBatches = chunkArray(cacheKeysArray, BATCH_SIZE);

        const batchPromises = cacheKeyBatches.map((batchCacheKeys, batchIndex) =>
            this.processBatch(batchCacheKeys, batchIndex, changesByCacheKey, jj),
        );

        const results = await Promise.all(batchPromises);
        const changed = results.some((c) => c);
        if (changed) {
            this._onDidUpdate.fire();
        }
        return changed;
    }

    private async processBatch(
        batchCacheKeys: string[],
        batchIndex: number,
        changesByCacheKey: Map<string, { commitId: string; description?: string }[]>,
        jj: JjService,
    ): Promise<boolean> {
        let batchChanged = false;
        this.outputChannel?.debug(
            `[GerritProvider] Fetching fresh status for batch ${batchIndex + 1} (${batchCacheKeys.length} changes)...`,
        );

        let fetchedInfoMap: Map<string, CodeForgeChangeInfo>;
        try {
            fetchedInfoMap = await this.fetchBatchFromNetwork(batchCacheKeys);
        } catch (error) {
            this.outputChannel?.error(`[GerritProvider] Failed to fetch batch Gerrit status: ${error}`);
            return false;
        }

        for (const cacheKey of batchCacheKeys) {
            const info = fetchedInfoMap.get(cacheKey);
            const oldInfo = this.cache.get(cacheKey);

            if (info) {
                const changesForCacheKey = changesByCacheKey.get(cacheKey) || [];
                await Promise.all(
                    changesForCacheKey.map((change) =>
                        this.verifyContentSync(change.commitId, change.description, info, jj),
                    ),
                );
                this.cache.set(cacheKey, info);
            } else {
                this.cache.delete(cacheKey);
            }

            if (JSON.stringify(oldInfo) !== JSON.stringify(info)) {
                batchChanged = true;
            }
        }
        return batchChanged;
    }

    private async fetchBatchFromNetwork(cacheKeys: string[]): Promise<Map<string, CodeForgeChangeInfo>> {
        const results = new Map<string, CodeForgeChangeInfo>();
        if (!this.gerritHost || cacheKeys.length === 0) {
            return results;
        }

        const baseUrl = `${this.gerritHost}/changes/`;
        const params = new URLSearchParams();
        for (const key of cacheKeys) {
            params.append('q', `change:${key}`);
        }
        params.append('o', 'LABELS');
        params.append('o', 'SUBMITTABLE');
        params.append('o', 'CURRENT_REVISION');
        params.append('o', 'CURRENT_FILES');
        params.append('o', 'CURRENT_COMMIT');

        const urlStr = `${baseUrl}?${params.toString()}`;
        this.outputChannel?.info(`[GerritProvider] GET ${urlStr}`);
        const response = await this.fetchGerrit(urlStr);
        if (!response.ok) {
            throw new Error(`Batch request failed with status: ${response.status}`);
        }

        const text = await response.text();
        const queryResults = this.parseBatchResponse(text);

        for (let i = 0; i < queryResults.length; i++) {
            const matches = queryResults[i];
            if (Array.isArray(matches) && matches.length > 0) {
                const info = this.parseGerritChange(matches[0]);
                if (info) {
                    results.set(cacheKeys[i], info);
                }
            }
        }
        return results;
    }

    private parseBatchResponse(text: string): GerritChange[][] {
        const jsonStr = text.replace(/^\)]}'\n/, '');
        let parsed: unknown;
        try {
            parsed = JSON.parse(jsonStr);
        } catch (e) {
            this.outputChannel?.error(`[GerritProvider] Error parsing batch response: ${e}`);
            return [];
        }

        const arraySchema = z.array(z.array(GerritChangeSchema).or(GerritChangeSchema));
        const validation = arraySchema.safeParse(parsed);

        if (!validation.success) {
            this.outputChannel?.error(
                `[GerritProvider] Validation failed for batch response: ${validation.error.message}`,
            );
            return [];
        }

        const { data } = validation;
        return this.isBatchResponse(data) ? data : [data as GerritChange[]];
    }

    private isBatchResponse(data: (GerritChange | GerritChange[])[]): data is GerritChange[][] {
        return data.length > 0 && Array.isArray(data[0]);
    }

    private parseGerritChange(change: GerritChange): CodeForgeChangeInfo | undefined {
        const currentRev = change.current_revision;
        let files: Record<string, { newSha?: string; status?: string }> | undefined;
        let remoteDescription: string | undefined;

        const rev = currentRev && change.revisions ? change.revisions[currentRev] : undefined;
        if (rev) {
            remoteDescription = rev.commit?.message;

            if (rev.files) {
                files = Object.entries(rev.files).reduce(
                    (acc, [path, fileInfo]) => {
                        if (!path.startsWith('/')) {
                            acc[path] = { newSha: fileInfo.new_sha, status: fileInfo.status };
                        }
                        return acc;
                    },
                    {} as Record<string, { newSha?: string; status?: string }>,
                );
            }
        }

        return {
            id: change.change_id,
            number: change._number,
            displayLabel: `CL/${change._number}`,
            providerName: 'Gerrit',
            status: change.status,
            submittable: change.submittable,
            url: `${this.gerritHost}/c/${change._number}`,
            unresolvedComments: change.unresolved_comment_count || 0,
            currentRevision: change.current_revision,
            files,
            remoteDescription,
            remoteParents: rev?.commit?.parents?.map((p) => p.commit),
        };
    }

    private async verifyContentSync(
        commitId: string,
        description: string | undefined,
        info: CodeForgeChangeInfo,
        jj: JjService,
    ): Promise<void> {
        if (info.status !== 'NEW' || !info.files) {
            return;
        }

        if (info.currentRevision === commitId) {
            info.contentSynced = true;
            return;
        }

        if (
            info.remoteDescription &&
            description &&
            stripGerritTrailers(description) !== stripGerritTrailers(info.remoteDescription)
        ) {
            return;
        }

        const gerritFiles = info.files;
        try {
            const localChanges = await jj.getChanges(commitId);
            const localPaths = new Set(localChanges.filter((c) => c.status !== 'deleted').map((c) => c.path));

            const gerritPaths = Object.keys(gerritFiles).filter((p) => gerritFiles[p].status !== 'D');
            const gerritPathSet = new Set(gerritPaths);

            if (localPaths.difference(gerritPathSet).size > 0 || gerritPathSet.difference(localPaths).size > 0) {
                return;
            }

            if (gerritPaths.length > 0) {
                const localHashes = await jj.getGitBlobHashes(commitId, gerritPaths);

                for (const file of gerritPaths) {
                    const gerritFile = gerritFiles[file];
                    const localSha = localHashes.get(file);

                    if (!localSha || localSha !== gerritFile.newSha) {
                        return;
                    }
                }
            }

            info.contentSynced = true;
        } catch (e) {
            this.outputChannel?.error(`[GerritProvider] Content sync verification failed for ${commitId}: ${e}`);
        }
    }

    public getUploadCommand(
        revision: string,
        _hasBookmark?: boolean,
    ): { subcommand: string; args: string[] } | undefined {
        return { subcommand: 'gerrit', args: ['upload', '-r', revision] };
    }

    public async getCommentThreads(changeId: string, signal?: AbortSignal): Promise<CodeForgeCommentThread[]> {
        const changeInfo = Array.from(this.cache.values()).find((info) => info.id === changeId);
        if (!changeInfo) {
            return [];
        }
        if (!this.gerritHost) {
            return [];
        }

        const url = `${this.gerritHost}/changes/${changeInfo.number}/comments`;
        const response = await this.fetchGerrit(url, { signal });
        if (!response.ok) {
            throw new Error(`Failed to fetch Gerrit comments: ${response.statusText}`);
        }

        const text = await response.text();
        const jsonStr = text.replace(/^\)]}'\n/, '');
        const commentsMap = JSON.parse(jsonStr) as Record<string, GerritCommentGql[]>;

        const threads: CodeForgeCommentThread[] = [];

        for (const [filePath, commentsList] of Object.entries(commentsMap)) {
            // Roots: comments that do not have in_reply_to, or whose parent is not in commentsList
            const commentIds = new Set(commentsList.map((c) => c.id));
            const roots = commentsList.filter((c) => !c.in_reply_to || !commentIds.has(c.in_reply_to));

            for (const root of roots) {
                const threadComments = [root];

                let addedNew = true;
                while (addedNew) {
                    addedNew = false;
                    for (const c of commentsList) {
                        if (
                            !threadComments.includes(c) &&
                            c.in_reply_to &&
                            threadComments.some((tc) => tc.id === c.in_reply_to)
                        ) {
                            threadComments.push(c);
                            addedNew = true;
                        }
                    }
                }

                // Sort chronologically
                threadComments.sort((a, b) => new Date(a.updated).getTime() - new Date(b.updated).getTime());

                const lastComment = threadComments[threadComments.length - 1];
                const isResolved = !lastComment.unresolved;

                threads.push({
                    id: root.id,
                    filePath,
                    line: root.line || undefined,
                    isResolved,
                    comments: threadComments.map((c) => ({
                        id: c.id,
                        author: {
                            name: c.author?.name || 'Unknown',
                            username: c.author?.username,
                        },
                        body: c.message || '',
                        createdAt: c.updated,
                    })),
                });
            }
        }

        return threads;
    }

    public async replyToCommentThread(changeId: string, threadId: string, body: string): Promise<CodeForgeComment> {
        const changeInfo = Array.from(this.cache.values()).find((info) => info.id === changeId);
        if (!changeInfo) {
            throw new Error('Change not found in cache');
        }
        if (!this.gerritHost) {
            throw new Error('Gerrit provider not fully configured');
        }

        // Fetch comments to locate parent file path and line
        const commentsUrl = `${this.gerritHost}/changes/${changeInfo.number}/comments`;
        const commentsResponse = await this.fetchGerrit(commentsUrl);
        if (!commentsResponse.ok) {
            throw new Error(`Failed to fetch comments to locate parent: ${commentsResponse.statusText}`);
        }
        const commentsText = await commentsResponse.text();
        const commentsMap = JSON.parse(commentsText.replace(/^\)]}'\n/, '')) as Record<string, GerritCommentGql[]>;

        let parentComment: GerritCommentGql | undefined;
        let parentFilePath: string | undefined;
        for (const [filePath, comments] of Object.entries(commentsMap)) {
            const found = comments.find((c) => c.id === threadId);
            if (found) {
                parentComment = found;
                parentFilePath = filePath;
                break;
            }
        }

        if (!parentComment || !parentFilePath) {
            throw new Error('Parent comment thread not found');
        }

        // Post review with comment reply
        const reviewUrl = `${this.gerritHost}/changes/${changeInfo.number}/revisions/current/review`;
        const response = await this.fetchGerrit(reviewUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'jj-view-vscode-extension',
            },
            body: JSON.stringify({
                drafts: 'PUBLISH',
                comments: {
                    [parentFilePath]: [
                        {
                            in_reply_to: threadId,
                            line: parentComment.line,
                            message: body,
                            unresolved: parentComment.unresolved ?? true,
                        },
                    ],
                },
            }),
        });

        if (!response.ok) {
            throw new Error(`Failed to post Gerrit reply: ${response.statusText}`);
        }

        // Re-fetch to retrieve the newly posted comment
        const updatedCommentsResponse = await this.fetchGerrit(commentsUrl);
        if (!updatedCommentsResponse.ok) {
            throw new Error('Failed to retrieve updated comments');
        }
        const updatedCommentsText = await updatedCommentsResponse.text();
        const updatedCommentsMap = JSON.parse(updatedCommentsText.replace(/^\)]}'\n/, '')) as Record<
            string,
            GerritCommentGql[]
        >;

        const threadComments = updatedCommentsMap[parentFilePath] || [];
        const replies = threadComments.filter((c) => c.in_reply_to === threadId || c.id === threadId);
        replies.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
        const newest = replies[0];

        if (!newest) {
            throw new Error('Could not find the newly created comment');
        }

        return {
            id: newest.id,
            author: {
                name: newest.author?.name || 'Unknown',
                username: newest.author?.username,
            },
            body: newest.message || '',
            createdAt: newest.updated,
        };
    }

    public async resolveCommentThread(changeId: string, threadId: string, resolved: boolean): Promise<void> {
        const changeInfo = Array.from(this.cache.values()).find((info) => info.id === changeId);
        if (!changeInfo) {
            throw new Error('Change not found in cache');
        }
        if (!this.gerritHost) {
            throw new Error('Gerrit provider not fully configured');
        }

        // Fetch comments to locate parent file path and line
        const commentsUrl = `${this.gerritHost}/changes/${changeInfo.number}/comments`;
        const commentsResponse = await this.fetchGerrit(commentsUrl);
        if (!commentsResponse.ok) {
            throw new Error(`Failed to fetch comments to locate parent: ${commentsResponse.statusText}`);
        }
        const commentsText = await commentsResponse.text();
        const commentsMap = JSON.parse(commentsText.replace(/^\)]}'\n/, '')) as Record<string, GerritCommentGql[]>;

        let parentComment: GerritCommentGql | undefined;
        let parentFilePath: string | undefined;
        for (const [filePath, comments] of Object.entries(commentsMap)) {
            const found = comments.find((c) => c.id === threadId);
            if (found) {
                parentComment = found;
                parentFilePath = filePath;
                break;
            }
        }

        if (!parentComment || !parentFilePath) {
            throw new Error('Parent comment thread not found');
        }

        // Post review with a resolution reply comment
        const reviewUrl = `${this.gerritHost}/changes/${changeInfo.number}/revisions/current/review`;
        const response = await this.fetchGerrit(reviewUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'jj-view-vscode-extension',
            },
            body: JSON.stringify({
                drafts: 'PUBLISH',
                comments: {
                    [parentFilePath]: [
                        {
                            in_reply_to: threadId,
                            line: parentComment.line,
                            message: resolved ? 'Resolved' : 'Unresolved',
                            unresolved: !resolved,
                        },
                    ],
                },
            }),
        });

        if (!response.ok) {
            throw new Error(`Failed to resolve Gerrit comment: ${response.statusText}`);
        }
    }

    public clearCache(): void {
        this.cache.clear();
        this.authHeader = undefined;
        this.authChecked = false;
        this._onDidUpdate.fire();
    }

    public activate(): void {
        this.outputChannel?.info('[GerritProvider] Activated');
    }

    public deactivate(): void {
        this.outputChannel?.info('[GerritProvider] Deactivated');
    }
}
