/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';
import { AsyncCache } from '../utils/async-cache';
import { Duration } from '../utils/duration';
import { LruCache } from '../utils/lru-cache';
import type { LoggerChannel } from '../utils/output-channel';
import type {
    ChangeStatusRequest,
    CodeForgeComment,
    CodeForgeCommentThread,
    CodeForgeProvider,
    GitRemote,
    UploadedFileRequest,
} from './code-forge-provider';
import {
    decodeBase64ToUint8Array,
    resolveLocalBranchComparisonScope,
    resolveLocalUploadedDetails,
    verifyLocalContentSync,
} from './code-forge-sync-utils';
import {
    CliForgeCommentSchema,
    CliForgeCommentThreadSchema,
    CliForgeDetectResultSchema,
    CliForgeFileContentResultSchema,
    CliForgeStatusRowSchema,
} from './custom-cli-forge-schemas';
import { type Event, EventEmitter } from './host/events';
import type { HostEnvironment } from './host/host-environment';
import type { JjService } from './jj-service';
import type { CodeForgeChangeInfo } from './jj-types';

function computeThreadDraftMetrics(threads: CodeForgeCommentThread[]): {
    draftComments: number;
    draftResponses: number;
    addressedThreads: number;
    hasDraftResponses: boolean;
} {
    let draftComments = 0;
    let draftResponses = 0;
    let addressedThreads = 0;

    for (const thread of threads) {
        if (thread.comments[0]?.isDraft) {
            draftComments++;
        }
        let threadHasDraftReply = false;
        for (let i = 1; i < thread.comments.length; i++) {
            if (thread.comments[i]?.isDraft) {
                draftResponses++;
                threadHasDraftReply = true;
            }
        }
        if (threadHasDraftReply && !thread.isResolved) {
            addressedThreads++;
        }
    }

    return {
        draftComments,
        draftResponses,
        addressedThreads,
        hasDraftResponses: draftResponses > 0,
    };
}

export class CustomCliForgeProvider implements CodeForgeProvider {
    public readonly priority = -10;

    private _id = 'custom';
    private _displayName = 'Custom Forge';
    private _changeTerm: 'CL' | 'PR' | 'Change' = 'CL';
    private _uploadModel: 'revision' | 'branch' | 'branch-stack' = 'revision';
    private _managedBookmarkRegex?: RegExp;
    private workspaceRoot?: string;

    private readonly _onDidUpdate = new EventEmitter<void>();
    public readonly onDidUpdate: Event<void> = this._onDidUpdate.event;

    private readonly cacheByChangeId = new LruCache<string, { info: CodeForgeChangeInfo; localCommitId: string }>({
        maxEntries: 1000,
    });
    private readonly immutableCommitCache = new LruCache<string, CodeForgeChangeInfo | null>({ maxEntries: 2000 });
    private readonly commentsCache = new AsyncCache<string, CodeForgeCommentThread[]>({
        ttl: Duration.seconds(30),
        maxEntries: 150,
        keepStaleOnError: true,
    });
    private readonly uploadedFileContentCache = new AsyncCache<string, Uint8Array | undefined>({
        ttl: Duration.minutes(10),
        maxEntries: 200,
        keepStaleOnError: true,
    });

    constructor(
        private readonly host: HostEnvironment,
        private readonly outputChannel?: LoggerChannel,
    ) {}

    public get id(): string {
        return this._id;
    }

    public get displayName(): string {
        return this._displayName;
    }

    public get changeTerm(): 'CL' | 'PR' | 'Change' {
        return this._changeTerm;
    }

    public get uploadModel(): 'revision' | 'branch' | 'branch-stack' {
        return this._uploadModel;
    }

    private getAdapterCommand(): string | undefined {
        const cmd = this.host.config.get<string>('codeForge.adapterCommand')?.trim();
        if (!cmd) {
            return undefined;
        }
        return cmd;
    }

    public async detect(workspaceRoot: string, _remotes?: GitRemote[]): Promise<boolean> {
        const adapterCommand = this.getAdapterCommand();
        if (!adapterCommand) {
            return false;
        }

        const system = this.host.system;
        if (!system) {
            return false;
        }

        if (this.workspaceRoot !== workspaceRoot) {
            this.clearCache();
            this.workspaceRoot = workspaceRoot;
        }

        try {
            const result = await system.process.execFile(adapterCommand, ['detect'], {
                cwd: workspaceRoot,
                timeout: 15000,
            });
            const parsedJson: unknown = JSON.parse(result.stdout);
            const parsed = CliForgeDetectResultSchema.parse(parsedJson);
            if (!parsed.detected) {
                return false;
            }

            this._id = parsed.id;
            this._displayName = parsed.displayName;
            this._changeTerm = parsed.changeTerm;
            this._uploadModel = parsed.uploadModel;
            this._managedBookmarkRegex = parsed.managedBookmarkPattern
                ? new RegExp(parsed.managedBookmarkPattern)
                : undefined;
            this.outputChannel?.info(
                `[CustomCliForgeProvider] Detected ${parsed.displayName} (${parsed.id}) at ${workspaceRoot}`,
            );
            return true;
        } catch (err) {
            this.outputChannel?.info(`[CustomCliForgeProvider] detect failed: ${err}`);
            return false;
        }
    }

    public isManagedBookmark(bookmarkName: string): boolean {
        if (!this._managedBookmarkRegex) {
            return false;
        }
        return this._managedBookmarkRegex.test(bookmarkName);
    }

    public getCachedChangeInfo(
        changeId?: string,
        _description?: string,
        _bookmarks?: string[],
        commitId?: string,
    ): CodeForgeChangeInfo | undefined {
        if (commitId && this.immutableCommitCache.has(commitId)) {
            const cachedImm = this.immutableCommitCache.get(commitId);
            if (cachedImm === null) {
                return undefined;
            }
            return cachedImm;
        }

        if (!changeId) {
            return undefined;
        }

        const cached = this.cacheByChangeId.get(changeId);
        if (!cached) {
            return undefined;
        }

        if (commitId && commitId !== cached.localCommitId && cached.info.status === 'NEW') {
            return {
                ...cached.info,
                contentSynced: cached.info.currentRevision === commitId,
                synced: false,
            };
        }

        return cached.info;
    }

    public async fetchStatuses(changes: ChangeStatusRequest[], jj: JjService): Promise<boolean> {
        const adapterCommand = this.getAdapterCommand();
        if (!adapterCommand) {
            return false;
        }

        const system = this.host.system;
        if (!system) {
            return false;
        }

        if (!this.workspaceRoot) {
            this.workspaceRoot = jj.workspaceRoot;
        }

        const toFetch = changes.filter((c) => !this.immutableCommitCache.has(c.commitId));
        if (toFetch.length === 0) {
            return false;
        }

        try {
            const result = await system.process.execFile(
                adapterCommand,
                ['statuses', '--revisions', ...toFetch.map((c) => c.commitId)],
                { cwd: jj.workspaceRoot, timeout: 30000 },
            );
            const rawJson: unknown = JSON.parse(result.stdout);
            const rows = z.array(CliForgeStatusRowSchema).parse(rawJson);

            const requestByCommitId = new Map(toFetch.map((c) => [c.commitId, c]));
            const pendingRows: Array<{
                row: z.infer<typeof CliForgeStatusRowSchema>;
                newInfo: CodeForgeChangeInfo;
                existing: { info: CodeForgeChangeInfo; localCommitId: string } | undefined;
            }> = [];
            let hasChanged = false;

            // Pass 1: parse all status rows and populate cacheByChangeId so branch-scope checks see stacked ancestors.
            for (const row of rows) {
                const existing = this.cacheByChangeId.get(row.changeId);
                if (!row.info) {
                    if (existing) {
                        this.cacheByChangeId.delete(row.changeId);
                        hasChanged = true;
                    }
                    continue;
                }

                let draftComments = existing?.info.draftComments;
                let draftResponses = existing?.info.draftResponses;
                let addressedThreads = existing?.info.addressedThreads;
                let hasDraftResponses = existing?.info.hasDraftResponses;

                if (row.info.hasDraftComments === true) {
                    const hasCachedDraftMetrics = (draftComments ?? 0) > 0 || (draftResponses ?? 0) > 0;
                    if (!hasCachedDraftMetrics) {
                        draftComments = 1;
                    }
                } else if (row.info.hasDraftComments === false) {
                    draftComments = 0;
                    draftResponses = 0;
                    addressedThreads = 0;
                    hasDraftResponses = false;
                }

                const newInfo: CodeForgeChangeInfo = {
                    id: row.info.id,
                    number: row.info.number ?? 0,
                    displayLabel: row.info.displayLabel ?? `${this.changeTerm} ${row.info.number ?? row.info.id}`,
                    providerName: this.displayName,
                    status: row.info.status ?? 'NEW',
                    submittable: row.info.submittable ?? false,
                    url: row.info.url,
                    unresolvedComments: row.info.unresolvedComments ?? 0,
                    draftComments,
                    draftResponses,
                    addressedThreads,
                    hasDraftResponses,
                    currentRevision: row.info.currentRevision,
                    remoteBaseRevision: row.info.remoteBaseRevision,
                    remoteDescription: row.info.remoteDescription,
                    files: row.info.files,
                    contentSynced: row.info.contentSynced,
                    parentSynced: row.info.parentSynced,
                    synced: row.info.synced,
                    remoteParents: row.info.remoteParents,
                };

                this.cacheByChangeId.set(row.changeId, { info: newInfo, localCommitId: row.commitId });
                pendingRows.push({ row, newInfo, existing });
            }

            // Pass 2: resolve Tier-1 uploaded file metadata, branch-scoped contentSynced, and change detection.
            const isBranchModel = this.uploadModel === 'branch' || this.uploadModel === 'branch-stack';
            for (const { row, newInfo, existing } of pendingRows) {
                if (newInfo.status === 'NEW' && newInfo.currentRevision && newInfo.files === undefined) {
                    const localDetails = await resolveLocalUploadedDetails(newInfo, jj, this.uploadModel).catch(
                        () => undefined,
                    );
                    if (localDetails) {
                        newInfo.files = localDetails.files;
                        if (newInfo.remoteDescription === undefined && localDetails.remoteDescription !== undefined) {
                            newInfo.remoteDescription = localDetails.remoteDescription;
                        }
                    }
                }

                if (newInfo.contentSynced === undefined && newInfo.status === 'NEW' && newInfo.files !== undefined) {
                    const req = requestByCommitId.get(row.commitId);
                    let localBaseCommitId: string | undefined;
                    if (isBranchModel && newInfo.remoteBaseRevision && row.commitId !== newInfo.currentRevision) {
                        const [logEntry] = await jj
                            .getLog({ revision: row.commitId, limit: 1, omitChanges: true })
                            .catch(() => []);
                        if (logEntry) {
                            const scope = await resolveLocalBranchComparisonScope(
                                jj,
                                logEntry,
                                newInfo,
                                this,
                                req?.changes,
                            );
                            localBaseCommitId = scope.localBaseCommitId;
                        }
                    }
                    newInfo.contentSynced = await verifyLocalContentSync({
                        commitId: row.commitId,
                        description: req?.description,
                        info: newInfo,
                        jj,
                        changes: req?.changes,
                        normalizeDescription: (desc) => desc.trim(),
                        localBaseCommitId,
                    });
                }

                if (
                    newInfo.synced === undefined &&
                    newInfo.contentSynced !== undefined &&
                    newInfo.parentSynced !== undefined
                ) {
                    newInfo.synced = newInfo.contentSynced && newInfo.parentSynced;
                }

                if (
                    !existing ||
                    existing.localCommitId !== row.commitId ||
                    existing.info.status !== newInfo.status ||
                    existing.info.currentRevision !== newInfo.currentRevision ||
                    existing.info.remoteBaseRevision !== newInfo.remoteBaseRevision ||
                    existing.info.remoteDescription !== newInfo.remoteDescription ||
                    JSON.stringify(existing.info.files) !== JSON.stringify(newInfo.files) ||
                    existing.info.contentSynced !== newInfo.contentSynced ||
                    existing.info.parentSynced !== newInfo.parentSynced ||
                    existing.info.synced !== newInfo.synced ||
                    existing.info.unresolvedComments !== newInfo.unresolvedComments ||
                    existing.info.draftComments !== newInfo.draftComments ||
                    existing.info.draftResponses !== newInfo.draftResponses ||
                    existing.info.addressedThreads !== newInfo.addressedThreads ||
                    existing.info.hasDraftResponses !== newInfo.hasDraftResponses ||
                    existing.info.submittable !== newInfo.submittable ||
                    existing.info.url !== newInfo.url
                ) {
                    hasChanged = true;
                }

                this.cacheByChangeId.set(row.changeId, { info: newInfo, localCommitId: row.commitId });
                if (newInfo.status === 'MERGED') {
                    this.immutableCommitCache.set(row.commitId, newInfo);
                }
            }

            if (hasChanged) {
                this._onDidUpdate.fire();
                return true;
            }
            return false;
        } catch (err) {
            this.outputChannel?.info(`[CustomCliForgeProvider] fetchStatuses failed: ${err}`);
            return false;
        }
    }

    public async uploadRevision(revision: string, jj: JjService): Promise<string> {
        const adapterCommand = this.getAdapterCommand();
        if (!adapterCommand) {
            throw new Error('Code forge adapter command is not configured.');
        }

        if (!this.workspaceRoot) {
            this.workspaceRoot = jj.workspaceRoot;
        }

        const output = await jj.runExternalMutation(adapterCommand, ['upload', '--revision', revision], {
            label: 'upload',
        });

        let matched = false;
        for (const [changeId, entry] of this.cacheByChangeId.entries()) {
            const matchesCommit =
                entry.localCommitId === revision || (revision.length >= 4 && entry.localCommitId.startsWith(revision));
            const matchesChange = changeId === revision || (revision.length >= 4 && changeId.startsWith(revision));
            const matchesCurrentRev =
                entry.info.currentRevision !== undefined &&
                (entry.info.currentRevision === revision ||
                    (revision.length >= 4 && entry.info.currentRevision.startsWith(revision)));
            if (matchesCommit || matchesChange || matchesCurrentRev) {
                matched = true;
                this.cacheByChangeId.delete(changeId);
                this.immutableCommitCache.delete(entry.localCommitId);
                void this.commentsCache.delete(entry.info.id);
                void this.commentsCache.delete(changeId);
            }
        }
        if (!matched) {
            this.cacheByChangeId.clear();
            void this.commentsCache.clear();
        }
        this.immutableCommitCache.delete(revision);
        void this.commentsCache.delete(revision);

        return output;
    }

    public async getCommentThreads(changeId: string, signal?: AbortSignal): Promise<CodeForgeCommentThread[]> {
        const adapterCommand = this.getAdapterCommand();
        if (!adapterCommand) {
            return [];
        }

        const system = this.host.system;
        if (!system) {
            return [];
        }

        const threads = await this.commentsCache.getOrFetch(changeId, async () => {
            if (signal?.aborted) {
                throw new Error('Operation aborted');
            }
            const result = await system.process.execFile(adapterCommand, ['list-comments', '--change-id', changeId], {
                cwd: this.workspaceRoot,
                timeout: 30000,
            });
            const rawJson: unknown = JSON.parse(result.stdout);
            return z.array(CliForgeCommentThreadSchema).parse(rawJson);
        });

        this.updateCachedDraftMetrics(changeId, threads);
        return threads;
    }

    private updateCachedDraftMetrics(changeId: string, threads: CodeForgeCommentThread[]): void {
        const metrics = computeThreadDraftMetrics(threads);
        let updated = false;
        for (const [key, entry] of this.cacheByChangeId.entries()) {
            if (key === changeId || entry.info.id === changeId || String(entry.info.number) === changeId) {
                if (
                    entry.info.draftComments !== metrics.draftComments ||
                    entry.info.draftResponses !== metrics.draftResponses ||
                    entry.info.addressedThreads !== metrics.addressedThreads ||
                    entry.info.hasDraftResponses !== metrics.hasDraftResponses
                ) {
                    entry.info.draftComments = metrics.draftComments;
                    entry.info.draftResponses = metrics.draftResponses;
                    entry.info.addressedThreads = metrics.addressedThreads;
                    entry.info.hasDraftResponses = metrics.hasDraftResponses;
                    updated = true;
                }
            }
        }
        if (updated) {
            this._onDidUpdate.fire();
        }
    }

    public async replyToCommentThread(
        changeId: string,
        thread: CodeForgeCommentThread,
        body: string,
        resolved?: boolean,
    ): Promise<CodeForgeComment> {
        const adapterCommand = this.getAdapterCommand();
        if (!adapterCommand) {
            throw new Error('Code forge adapter command is not configured.');
        }

        const system = this.host.system;
        if (!system) {
            throw new Error('Host system is unavailable.');
        }

        const args = ['reply-comment', '--change-id', changeId, '--thread-id', thread.id, '--body', body];
        if (resolved) {
            args.push('--resolve');
        }

        const result = await system.process.execFile(adapterCommand, args, {
            cwd: this.workspaceRoot,
            timeout: 30000,
        });
        const rawJson: unknown = JSON.parse(result.stdout);
        const parsed = CliForgeCommentSchema.parse(rawJson);

        void this.commentsCache.delete(changeId);
        return parsed;
    }

    public async resolveCommentThread(
        changeId: string,
        thread: CodeForgeCommentThread,
        resolved: boolean,
    ): Promise<void> {
        const adapterCommand = this.getAdapterCommand();
        if (!adapterCommand) {
            throw new Error('Code forge adapter command is not configured.');
        }

        const system = this.host.system;
        if (!system) {
            throw new Error('Host system is unavailable.');
        }

        await system.process.execFile(
            adapterCommand,
            ['resolve-comment', '--change-id', changeId, '--thread-id', thread.id, '--resolved', String(resolved)],
            {
                cwd: this.workspaceRoot,
                timeout: 30000,
            },
        );

        void this.commentsCache.delete(changeId);
    }

    public async getUploadedFileContent(request: UploadedFileRequest): Promise<Uint8Array | undefined> {
        const adapterCommand = this.getAdapterCommand();
        if (!adapterCommand) {
            return undefined;
        }
        const system = this.host.system;
        if (!system) {
            return undefined;
        }

        const cleanPath = request.filePath.replace(/^\/+/, '');
        const cacheKey = `${request.changeId}:${request.revisionId}:${cleanPath}`;
        return this.uploadedFileContentCache.getOrFetch(cacheKey, async () => {
            const result = await system.process.execFile(
                adapterCommand,
                [
                    'get-file-content',
                    '--change-id',
                    request.changeId,
                    '--revision',
                    request.revisionId,
                    '--path',
                    cleanPath,
                ],
                { cwd: this.workspaceRoot, timeout: 30000 },
            );
            const rawJson: unknown = JSON.parse(result.stdout);
            const parsed = CliForgeFileContentResultSchema.parse(rawJson);
            if (!parsed || parsed.found === false) {
                return undefined;
            }
            if (parsed.contentBase64 !== undefined) {
                return decodeBase64ToUint8Array(parsed.contentBase64);
            }
            if (parsed.encoding === 'base64' && parsed.content !== undefined) {
                return decodeBase64ToUint8Array(parsed.content);
            }
            if (parsed.content !== undefined) {
                return new TextEncoder().encode(parsed.content);
            }
            return undefined;
        });
    }

    public activate(): void {
        this.outputChannel?.info(`[CustomCliForgeProvider] Activated (${this._displayName})`);
    }

    public deactivate(): void {}

    public clearCache(): void {
        this.cacheByChangeId.clear();
        this.immutableCommitCache.clear();
        void this.commentsCache.clear();
        void this.uploadedFileContentCache.clear();
    }

    public dispose(): void {
        this.clearCache();
        this._onDidUpdate.dispose();
    }
}
