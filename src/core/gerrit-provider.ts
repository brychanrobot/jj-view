/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { chunkArray } from '../utils/array-utils';
import { fetchWithTimeout } from '../utils/fetch-utils';
import { getGerritAuthHeader, resolveGitRoot } from '../utils/gerrit-credential-utils';
import { detectGerritHost } from '../utils/gerrit-host-detection';
import { resolveGerritChangeKey, stripGerritTrailers } from '../utils/gerrit-utils';
import { convertJjChangeIdToHex } from '../utils/jj-utils';
import type { LoggerChannel } from '../utils/output-channel';
import type {
    ChangeStatusRequest,
    CodeForgeComment,
    CodeForgeCommentThread,
    CodeForgeProvider,
    GitRemote,
} from './code-forge-provider';
import { type Event, EventEmitter } from './host/events';
import type { HostEnvironment } from './host/host-environment';
import type { JjService } from './jj-service';
import type { CodeForgeChangeInfo, JjStatusEntry } from './jj-types';

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
    patch_set?: number;
}

export type GerritCommentWithDraftStatus = GerritCommentGql & {
    isDraft?: boolean;
};

interface FetchGerritOptions extends RequestInit {
    timeoutMs?: number;
}

const AUTH_HEADER_TTL_MS = 5 * 60 * 1000;

function parseGerritJsonResponse<T>(text: string): T {
    const cleanJson = text.replace(/^\)]}'\r?\n/, '').trim();
    if (!cleanJson) {
        return {} as T;
    }
    return JSON.parse(cleanJson) as T;
}

export class GerritProvider implements CodeForgeProvider {
    public readonly id = 'gerrit';
    public readonly displayName = 'Gerrit';
    public readonly changeTerm = 'CL' as const;
    public readonly priority = 100;

    private cache = new Map<string, CodeForgeChangeInfo>();
    private contentSyncCache = new Map<string, boolean>();
    private gerritHost: string | undefined;
    private repoRoot: string | undefined;
    private gitRoot: string | null = null;
    private authHeader: { name: string; value: string } | undefined;
    private authChecked = false;
    private lastAuthTime = 0;

    private _onDidUpdate = new EventEmitter<void>();
    public readonly onDidUpdate: Event<void> = this._onDidUpdate.event;

    constructor(
        private outputChannel: LoggerChannel,
        private host: HostEnvironment,
    ) {}

    public async detect(repoRoot: string, remotes: GitRemote[]): Promise<boolean> {
        const binaryPath = this.host.config.get<string>('binaryPath', 'jj') || 'jj';
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
            this.host,
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
        const now = Date.now();
        if (this.authChecked && now - this.lastAuthTime < AUTH_HEADER_TTL_MS) {
            return this.authHeader;
        }
        const start = performance.now();
        this.authChecked = true;
        this.lastAuthTime = now;
        this.authHeader = await getGerritAuthHeader(this.gerritHost, this.gitRoot, this.outputChannel);
        const duration = performance.now() - start;
        this.outputChannel?.info(`[timing] [Gerrit] auth resolution took ${duration.toFixed(0)}ms`);
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
        const response = await fetchWithTimeout(finalUrl, timeout, { ...options, headers });

        if (response.status === 401 || response.status === 403) {
            this.outputChannel?.warn(
                `[GerritProvider] Request to ${finalUrl} failed with status ${response.status}. Invalidating cached auth header.`,
            );
            this.authHeader = undefined;
            this.authChecked = false;
            this.lastAuthTime = 0;
        }

        return response;
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

        const start = performance.now();
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
            this.processBatch(batchCacheKeys, batchIndex, cacheKeyBatches.length, changesByCacheKey, jj),
        );

        const results = await Promise.all(batchPromises);
        const changed = results.some((c) => c);
        if (changed) {
            this._onDidUpdate.fire();
        }

        const duration = performance.now() - start;
        const batchSuffix = cacheKeyBatches.length === 1 ? 'batch' : 'batches';
        this.outputChannel?.info(
            `[timing] [Gerrit] fetchStatuses took ${duration.toFixed(0)}ms (${changes.length} changes in ${cacheKeyBatches.length} ${batchSuffix})`,
        );

        return changed;
    }

    private async processBatch(
        batchCacheKeys: string[],
        batchIndex: number,
        totalBatches: number,
        changesByCacheKey: Map<string, ChangeStatusRequest[]>,
        jj: JjService,
    ): Promise<boolean> {
        let batchChanged = false;
        this.outputChannel?.debug(
            `[GerritProvider] Fetching fresh status for batch ${batchIndex + 1} (${batchCacheKeys.length} changes)...`,
        );

        let fetchedInfoMap: Map<string, CodeForgeChangeInfo>;
        try {
            fetchedInfoMap = await this.fetchBatchFromNetwork(batchCacheKeys, batchIndex, totalBatches);
        } catch (error) {
            this.outputChannel?.error(`[GerritProvider] Failed to fetch batch Gerrit status: ${error}`);
            return false;
        }

        const syncStart = performance.now();
        let fastHits = 0;
        let deepChecks = 0;

        for (const cacheKey of batchCacheKeys) {
            const info = fetchedInfoMap.get(cacheKey);
            const oldInfo = this.cache.get(cacheKey);

            if (info) {
                const changesForCacheKey = changesByCacheKey.get(cacheKey) || [];
                await Promise.all(
                    changesForCacheKey.map(async (change) => {
                        const result = await this.verifyContentSync(
                            change.commitId,
                            change.description,
                            info,
                            jj,
                            change.changes,
                        );
                        if (result === 'fast') {
                            fastHits++;
                        } else if (result === 'checked') {
                            deepChecks++;
                        }
                    }),
                );
                this.cache.set(cacheKey, info);
            } else {
                this.cache.delete(cacheKey);
            }

            if (JSON.stringify(oldInfo) !== JSON.stringify(info)) {
                batchChanged = true;
            }
        }

        const syncDuration = performance.now() - syncStart;
        this.outputChannel?.info(
            `[timing] [Gerrit] batch ${batchIndex + 1}/${totalBatches} content sync verification took ${syncDuration.toFixed(0)}ms (${fastHits} hits, ${deepChecks} checks)`,
        );

        return batchChanged;
    }

    private async fetchBatchFromNetwork(
        cacheKeys: string[],
        batchIndex = 0,
        totalBatches = 1,
    ): Promise<Map<string, CodeForgeChangeInfo>> {
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

        const netStart = performance.now();
        const response = await this.fetchGerrit(urlStr);
        if (!response.ok) {
            throw new Error(`Batch request failed with status: ${response.status}`);
        }

        const text = await response.text();
        const netDuration = performance.now() - netStart;

        const parseStart = performance.now();
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
        const parseDuration = performance.now() - parseStart;

        this.outputChannel?.info(
            `[timing] [Gerrit] batch ${batchIndex + 1}/${totalBatches} HTTP request took ${netDuration.toFixed(0)}ms (parse: ${parseDuration.toFixed(0)}ms, ${cacheKeys.length} changes)`,
        );

        return results;
    }

    private parseBatchResponse(text: string): GerritChange[][] {
        const jsonStr = text.replace(/^\)]}'\r?\n/, '');
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
        changes?: JjStatusEntry[],
    ): Promise<'fast' | 'checked' | 'skipped'> {
        if (info.status !== 'NEW' || !info.files) {
            return 'skipped';
        }

        if (info.currentRevision === commitId) {
            info.contentSynced = true;
            return 'fast';
        }

        const syncCacheKey = `${commitId}:${info.currentRevision ?? ''}`;
        if (this.contentSyncCache.has(syncCacheKey)) {
            const cached = this.contentSyncCache.get(syncCacheKey);
            if (cached) {
                info.contentSynced = true;
            }
            return 'fast';
        }

        if (
            info.remoteDescription &&
            description &&
            stripGerritTrailers(description) !== stripGerritTrailers(info.remoteDescription)
        ) {
            this.contentSyncCache.set(syncCacheKey, false);
            return 'checked';
        }

        const gerritFiles = info.files;
        let getChangesMs = 0;
        let blobHashesMs = 0;
        let gerritFileCount = 0;
        const syncStart = performance.now();

        try {
            let localChanges = changes;
            if (!localChanges) {
                const changesStart = performance.now();
                localChanges = await jj.getChanges(commitId);
                getChangesMs = performance.now() - changesStart;
            }
            const localPaths = new Set(localChanges.filter((c) => c.status !== 'deleted').map((c) => c.path));

            const gerritPaths = Object.keys(gerritFiles).filter((p) => gerritFiles[p].status !== 'D');
            gerritFileCount = gerritPaths.length;
            const gerritPathSet = new Set(gerritPaths);

            if (localPaths.difference(gerritPathSet).size > 0 || gerritPathSet.difference(localPaths).size > 0) {
                this.contentSyncCache.set(syncCacheKey, false);
                return 'checked';
            }

            if (gerritPaths.length > 0) {
                const hashesStart = performance.now();
                const localHashes = await jj.getGitBlobHashes(commitId, gerritPaths);
                blobHashesMs = performance.now() - hashesStart;

                for (const file of gerritPaths) {
                    const gerritFile = gerritFiles[file];
                    const localSha = localHashes.get(file);

                    if (!localSha || localSha !== gerritFile.newSha) {
                        this.contentSyncCache.set(syncCacheKey, false);
                        return 'checked';
                    }
                }
            }

            info.contentSynced = true;
            this.contentSyncCache.set(syncCacheKey, true);
            return 'checked';
        } catch (e) {
            this.outputChannel?.error(`[GerritProvider] Content sync verification failed for ${commitId}: ${e}`);
            return 'checked';
        } finally {
            const totalMs = performance.now() - syncStart;
            if (getChangesMs > 0 || blobHashesMs > 0) {
                this.outputChannel?.info(
                    `[timing] [Gerrit] local diff/hashes for ${commitId.slice(0, 8)} took ${totalMs.toFixed(0)}ms (${getChangesMs.toFixed(0)}ms diff, ${blobHashesMs.toFixed(0)}ms ls-tree, ${gerritFileCount} files)`,
                );
            }
        }
    }

    public getUploadCommand(
        revision: string,
        _hasBookmark?: boolean,
    ): { subcommand: string; args: string[] } | undefined {
        return { subcommand: 'gerrit', args: ['upload', '-r', revision] };
    }

    private async fetchMergedCommentsAndDrafts(
        changeNumber: number,
        signal?: AbortSignal,
    ): Promise<Record<string, GerritCommentWithDraftStatus[]>> {
        if (!this.gerritHost) {
            return {};
        }

        const commentsUrl = `${this.gerritHost}/changes/${changeNumber}/comments`;
        const draftsUrl = `${this.gerritHost}/changes/${changeNumber}/drafts`;

        const [commentsResponse, draftsResponse] = await Promise.all([
            this.fetchGerrit(commentsUrl, { signal }).catch(() => undefined),
            this.fetchGerrit(draftsUrl, { signal }).catch(() => undefined),
        ]);

        if (!commentsResponse?.ok) {
            const status = commentsResponse?.status ? `${commentsResponse.status} ` : '';
            const statusText = commentsResponse?.statusText || 'Network error';
            throw new Error(`Failed to fetch Gerrit comments: ${status}${statusText}`.trim());
        }

        const commentsText = await commentsResponse.text();
        const publishedCommentsMap = parseGerritJsonResponse<Record<string, GerritCommentGql[]>>(commentsText);

        let draftsMap: Record<string, GerritCommentGql[]> = {};
        if (draftsResponse?.ok) {
            try {
                const draftsText = await draftsResponse.text();
                draftsMap = parseGerritJsonResponse<Record<string, GerritCommentGql[]>>(draftsText);
            } catch (err) {
                this.outputChannel?.warn(`[GerritProvider] Failed to parse Gerrit draft comments response: ${err}`);
            }
        }

        const commentsMap: Record<string, GerritCommentWithDraftStatus[]> = {};
        const filePaths = new Set([...Object.keys(publishedCommentsMap), ...Object.keys(draftsMap)]);

        for (const filePath of filePaths) {
            const list1 = (publishedCommentsMap[filePath] || []).map((c) => ({ ...c, isDraft: false }));
            const list2 = (draftsMap[filePath] || []).map((c) => ({ ...c, isDraft: true }));
            const seenIds = new Set<string>();
            const combined: GerritCommentWithDraftStatus[] = [];

            for (const c of [...list1, ...list2]) {
                if (!seenIds.has(c.id)) {
                    seenIds.add(c.id);
                    combined.push(c);
                }
            }
            commentsMap[filePath] = combined;
        }

        return commentsMap;
    }

    public async getCommentThreads(changeId: string, signal?: AbortSignal): Promise<CodeForgeCommentThread[]> {
        const changeInfo = Array.from(this.cache.values()).find((info) => info.id === changeId);
        if (!changeInfo) {
            return [];
        }
        if (!this.gerritHost) {
            return [];
        }

        const commentsMap = await this.fetchMergedCommentsAndDrafts(changeInfo.number, signal);
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
                    metadata: {
                        patchSet: root.patch_set,
                    },
                    comments: threadComments.map((c) => ({
                        id: c.id,
                        author: {
                            name: c.author?.name || 'Unknown',
                            username: c.author?.username,
                        },
                        body: c.message || '',
                        createdAt: c.updated,
                        isDraft: c.isDraft,
                    })),
                });
            }
        }

        return threads;
    }

    public async replyToCommentThread(
        changeId: string,
        thread: CodeForgeCommentThread,
        body: string,
        resolved?: boolean,
    ): Promise<CodeForgeComment> {
        const changeInfo = Array.from(this.cache.values()).find((info) => info.id === changeId);
        if (!changeInfo) {
            throw new Error('Change not found in cache');
        }
        if (!this.gerritHost) {
            throw new Error('Gerrit provider not fully configured');
        }

        // Post draft comment reply
        const patchSet =
            typeof thread.metadata?.patchSet === 'number' &&
            Number.isSafeInteger(thread.metadata.patchSet) &&
            thread.metadata.patchSet > 0
                ? thread.metadata.patchSet
                : undefined;
        const revisionId = patchSet ?? 'current';
        const draftUrl = `${this.gerritHost}/changes/${changeInfo.number}/revisions/${revisionId}/drafts`;
        const filePath = thread.filePath || '/PATCHSET_LEVEL';
        const line =
            typeof thread.line === 'number' && Number.isSafeInteger(thread.line) && thread.line > 0
                ? thread.line
                : undefined;

        const response = await this.fetchGerrit(draftUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'jj-view-vscode-extension',
            },
            body: JSON.stringify({
                path: filePath,
                line,
                message: body,
                in_reply_to: thread.id,
                unresolved: resolved !== undefined ? !resolved : !thread.isResolved,
            }),
        });

        if (!response.ok) {
            const errorBody = (await response.text().catch(() => '')).trim();
            const statusText = response.statusText ? ` ${response.statusText}` : '';
            throw new Error(
                `Failed to post Gerrit draft reply: ${response.status}${statusText}${errorBody ? ` - ${errorBody}` : ''}`,
            );
        }

        const responseText = await response.text();
        if (responseText) {
            try {
                const createdDraft = parseGerritJsonResponse<GerritCommentGql>(responseText);
                if (createdDraft?.id) {
                    return {
                        id: createdDraft.id,
                        author: {
                            name: createdDraft.author?.name || 'Unknown',
                            username: createdDraft.author?.username,
                        },
                        body: createdDraft.message || body,
                        createdAt: createdDraft.updated || new Date().toISOString(),
                        isDraft: true,
                    };
                }
            } catch {
                // Fallback to re-fetching
            }
        }

        // Re-fetch to retrieve the newly posted draft comment
        const updatedMap = await this.fetchMergedCommentsAndDrafts(changeInfo.number);
        const threadComments = updatedMap[filePath] || [];
        const replies = threadComments.filter(
            (c) => c.in_reply_to === thread.id && c.id !== thread.id && Boolean(c.isDraft),
        );
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
            isDraft: !!newest.isDraft,
        };
    }

    public async resolveCommentThread(
        changeId: string,
        thread: CodeForgeCommentThread,
        resolved: boolean,
    ): Promise<void> {
        const changeInfo = Array.from(this.cache.values()).find((info) => info.id === changeId);
        if (!changeInfo) {
            throw new Error('Change not found in cache');
        }
        if (!this.gerritHost) {
            throw new Error('Gerrit provider not fully configured');
        }

        // Post draft resolution reply comment
        const patchSet =
            typeof thread.metadata?.patchSet === 'number' &&
            Number.isSafeInteger(thread.metadata.patchSet) &&
            thread.metadata.patchSet > 0
                ? thread.metadata.patchSet
                : undefined;
        const revisionId = patchSet ?? 'current';
        const draftUrl = `${this.gerritHost}/changes/${changeInfo.number}/revisions/${revisionId}/drafts`;
        const filePath = thread.filePath || '/PATCHSET_LEVEL';
        const line =
            typeof thread.line === 'number' && Number.isSafeInteger(thread.line) && thread.line > 0
                ? thread.line
                : undefined;

        const response = await this.fetchGerrit(draftUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'jj-view-vscode-extension',
            },
            body: JSON.stringify({
                path: filePath,
                line,
                message: resolved ? 'Resolved' : 'Unresolved',
                in_reply_to: thread.id,
                unresolved: !resolved,
            }),
        });

        if (!response.ok) {
            const errorBody = (await response.text().catch(() => '')).trim();
            const statusText = response.statusText ? ` ${response.statusText}` : '';
            throw new Error(
                `Failed to resolve Gerrit comment: ${response.status}${statusText}${errorBody ? ` - ${errorBody}` : ''}`,
            );
        }
    }

    public clearCache(): void {
        this.cache.clear();
        this.contentSyncCache.clear();
        this.authHeader = undefined;
        this.authChecked = false;
        this.lastAuthTime = 0;
        this._onDidUpdate.fire();
    }

    public activate(): void {
        this.outputChannel?.info('[GerritProvider] Activated');
    }

    public deactivate(): void {
        this.outputChannel?.info('[GerritProvider] Deactivated');
    }

    public dispose(): void {
        this._onDidUpdate.dispose();
    }
}
