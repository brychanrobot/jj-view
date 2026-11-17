/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LruCache } from '../utils/lru-cache';
import type {
    ChangeStatusRequest,
    CodeForgeProvider,
    UploadedRevisionDetails,
    UploadedRevisionFile,
} from './code-forge-provider';
import type { CodeForgeChangeInfo, JjFileChange, JjLogEntry, JjStatusEntry } from './jj-schemas';
import type { JjService } from './jj-service';

export function decodeBase64ToUint8Array(base64: string): Uint8Array {
    const cleaned = base64.replace(/\s+/g, '');
    return Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
}

const JJ_STATUS_TO_GIT_STATUS: Readonly<Record<JjFileChange['status'], string>> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
};

export function areUint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) {
        return false;
    }
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

export function mapJjChangesToUploadedFiles(changes: readonly JjFileChange[]): Record<string, UploadedRevisionFile> {
    const files: Record<string, UploadedRevisionFile> = {};
    for (const c of changes) {
        files[c.path] = {
            status: JJ_STATUS_TO_GIT_STATUS[c.status] ?? 'M',
            ...(c.oldPath ? { oldPath: c.oldPath } : {}),
        };
    }
    return files;
}

/**
 * Tier 1 uploaded revision resolution using the local `.git` store (or `jj` store on non-Git workspaces)
 * with zero network calls. Returns `undefined` if the remote revision is absent locally.
 */
export async function resolveLocalUploadedDetails(
    info: CodeForgeChangeInfo,
    jj: JjService,
    uploadModel?: 'revision' | 'branch' | 'branch-stack',
): Promise<UploadedRevisionDetails | undefined> {
    if (info.files !== undefined) {
        return {
            files: info.files,
            remoteDescription: info.remoteDescription,
        };
    }

    const remoteRev = info.currentRevision;
    if (!remoteRev) {
        return undefined;
    }

    const gitRoot = await jj.getGitRoot();
    if (gitRoot) {
        const isBranchModel = uploadModel === 'branch' || uploadModel === 'branch-stack';
        const isSingleCommitAboveBase =
            info.remoteParents !== undefined &&
            info.remoteParents.length === 1 &&
            info.remoteBaseRevision !== undefined &&
            info.remoteParents[0] === info.remoteBaseRevision;

        if (isBranchModel && info.remoteBaseRevision && !isSingleCommitAboveBase) {
            const [rangeFiles, commitDetails] = await Promise.all([
                jj.getGitRangeFiles(info.remoteBaseRevision, remoteRev),
                info.remoteDescription !== undefined ? Promise.resolve(undefined) : jj.getGitCommitDetails(remoteRev),
            ]);
            if (rangeFiles === undefined) {
                return undefined;
            }
            return {
                files: rangeFiles,
                remoteDescription: info.remoteDescription ?? commitDetails?.description,
            };
        }

        const commitDetails = await jj.getGitCommitDetails(remoteRev);
        if (commitDetails !== undefined) {
            return {
                files: commitDetails.files,
                remoteDescription: info.remoteDescription ?? commitDetails.description,
            };
        }
        return undefined;
    }

    // Non-Git workspace (e.g. .citc): check whether remoteRev exists directly in jj's store
    try {
        const [remoteLog] = await jj.getLog({ revision: remoteRev, limit: 1, omitChanges: false });
        if (!remoteLog) {
            return undefined;
        }
        return {
            files: mapJjChangesToUploadedFiles(remoteLog.changes ?? []),
            remoteDescription: info.remoteDescription ?? remoteLog.description,
        };
    } catch {
        return undefined;
    }
}

export interface LocalBranchComparisonScope {
    localChanges: readonly JjFileChange[];
    localBaseCommitId?: string;
}

/**
 * Resolves the local diff scope for a change. For single-commit changes and stacked 1-commit-per-bookmark
 * PRs/MRs this returns the commit's direct changes; for multi-commit branch PRs/MRs with unbookmarked mutable
 * ancestors above `remoteBaseRevision`, this spans the branch segment up to `logEntry.commit_id`.
 */
export async function resolveLocalBranchComparisonScope(
    jj: JjService,
    logEntry: JjLogEntry,
    info: CodeForgeChangeInfo,
    activeProvider?: CodeForgeProvider,
    preloadedChanges?: readonly JjStatusEntry[],
): Promise<LocalBranchComparisonScope> {
    const directChanges = async (): Promise<readonly JjFileChange[]> =>
        preloadedChanges ?? logEntry.changes ?? jj.getChanges(logEntry.commit_id);

    if (
        activeProvider?.uploadModel === 'revision' ||
        !info.remoteBaseRevision ||
        logEntry.parents.length === 0 ||
        logEntry.parents.every((parent) => parent.is_immutable)
    ) {
        return { localChanges: await directChanges() };
    }

    const MUTABLE_ANCESTORS_LIMIT = 200;
    const mutableAncestors = await jj.getLog({
        revision: `::${logEntry.commit_id} & mutable()`,
        limit: MUTABLE_ANCESTORS_LIMIT,
        omitChanges: true,
    });
    const byCommitId = new Map<string, JjLogEntry>();
    for (const entry of mutableAncestors) {
        byCommitId.set(entry.commit_id, entry);
    }

    const branchCommits = new Set<string>([logEntry.commit_id]);
    const queue = logEntry.parents.filter((p) => !p.is_immutable).map((p) => p.commit_id);
    const boundaryParents = new Set<string>();

    while (queue.length > 0) {
        const ancestorId = queue.shift();
        if (!ancestorId || branchCommits.has(ancestorId)) {
            continue;
        }
        if (ancestorId === info.remoteBaseRevision) {
            boundaryParents.add(ancestorId);
            continue;
        }
        const ancestorEntry = byCommitId.get(ancestorId);
        if (!ancestorEntry) {
            if (mutableAncestors.length >= MUTABLE_ANCESTORS_LIMIT) {
                return { localChanges: await directChanges() };
            }
            boundaryParents.add(ancestorId);
            continue;
        }
        if (ancestorEntry.is_immutable) {
            boundaryParents.add(ancestorId);
            continue;
        }

        const localBookmarks = (ancestorEntry.bookmarks ?? [])
            .filter((b) => !b.remote && !activeProvider?.isManagedBookmark?.(b.name))
            .map((b) => b.name);
        const hasOwnForgeChange = Boolean(
            activeProvider?.getCachedChangeInfo(
                ancestorEntry.change_id,
                ancestorEntry.description,
                localBookmarks,
                ancestorEntry.commit_id,
            ),
        );
        if (localBookmarks.length > 0 || hasOwnForgeChange) {
            boundaryParents.add(ancestorId);
            continue;
        }

        branchCommits.add(ancestorId);
        for (const parent of ancestorEntry.parents) {
            if (parent.is_immutable || parent.commit_id === info.remoteBaseRevision) {
                boundaryParents.add(parent.commit_id);
            } else {
                queue.push(parent.commit_id);
            }
        }
    }

    if (branchCommits.size <= 1 || boundaryParents.size !== 1) {
        return { localChanges: await directChanges() };
    }

    const [localBaseCommitId] = Array.from(boundaryParents);
    if (!localBaseCommitId) {
        return { localChanges: await directChanges() };
    }

    const rangeChanges = await jj.getChangesBetween(localBaseCommitId, logEntry.commit_id);
    return {
        localChanges: rangeChanges,
        localBaseCommitId,
    };
}

export interface VerifyLocalContentSyncOptions {
    commitId: string;
    description: string | undefined;
    info: CodeForgeChangeInfo;
    jj: JjService;
    changes?: readonly JjStatusEntry[];
    normalizeDescription: (description: string) => string;
    localBaseCommitId?: string;
}

/**
 * Rebase-aware content sync verification comparing normalized commit description, changed/deleted file sets,
 * and blob SHAs (with binary byte fallback on non-Git workspaces).
 */
export async function verifyLocalContentSync(options: VerifyLocalContentSyncOptions): Promise<boolean | undefined> {
    const { commitId, description, info, jj, normalizeDescription } = options;
    if (!info.files) {
        return undefined;
    }
    if (info.currentRevision === commitId) {
        return true;
    }

    if (
        info.remoteDescription !== undefined &&
        description !== undefined &&
        normalizeDescription(description) !== normalizeDescription(info.remoteDescription)
    ) {
        return false;
    }

    const remoteFiles = info.files;
    const localChanges = options.localBaseCommitId
        ? await jj.getChangesBetween(options.localBaseCommitId, commitId)
        : (options.changes ?? (await jj.getChanges(commitId)));

    const localPaths = new Set(localChanges.filter((c) => c.status !== 'deleted').map((c) => c.path));
    const localDeletedPaths = new Set<string>();
    for (const c of localChanges) {
        if (c.status === 'deleted' && !localPaths.has(c.path)) {
            localDeletedPaths.add(c.path);
        } else if (c.status === 'renamed' && c.oldPath && !localPaths.has(c.oldPath)) {
            localDeletedPaths.add(c.oldPath);
        }
    }

    const remotePaths = Object.keys(remoteFiles).filter((p) => remoteFiles[p].status !== 'D');
    const remotePathSet = new Set(remotePaths);
    const remoteDeletedPaths = new Set<string>();
    for (const [p, f] of Object.entries(remoteFiles)) {
        if (f.status === 'D' && !remotePathSet.has(p)) {
            remoteDeletedPaths.add(p);
        } else if (f.status === 'R' && f.oldPath && !remotePathSet.has(f.oldPath)) {
            remoteDeletedPaths.add(f.oldPath);
        }
    }

    if (
        localPaths.difference(remotePathSet).size > 0 ||
        remotePathSet.difference(localPaths).size > 0 ||
        localDeletedPaths.difference(remoteDeletedPaths).size > 0 ||
        remoteDeletedPaths.difference(localDeletedPaths).size > 0
    ) {
        return false;
    }

    if (remotePaths.length === 0) {
        return true;
    }

    const gitRoot = await jj.getGitRoot();
    if (gitRoot) {
        const localHashes = await jj.getGitBlobHashes(commitId, remotePaths);
        for (const filePath of remotePaths) {
            const remoteSha = remoteFiles[filePath]?.newSha;
            const localSha = localHashes.get(filePath);
            if (!remoteSha || !localSha || localSha !== remoteSha) {
                return false;
            }
        }
        return true;
    }

    if (!info.currentRevision) {
        return undefined;
    }

    for (const filePath of remotePaths) {
        try {
            const [localBytes, remoteBytes] = await Promise.all([
                jj.getFileBinaryContent(filePath, commitId),
                jj.getFileBinaryContent(filePath, info.currentRevision),
            ]);
            if (!areUint8ArraysEqual(localBytes, remoteBytes)) {
                return false;
            }
        } catch {
            return false;
        }
    }
    return true;
}

export function getBookmarkCachedChangeInfo(
    cache: ReadonlyMap<string, CodeForgeChangeInfo>,
    contentSyncCache: LruCache<string, boolean>,
    bookmarks?: readonly string[],
    commitId?: string,
): CodeForgeChangeInfo | undefined {
    if (!bookmarks || bookmarks.length === 0) {
        return undefined;
    }
    for (const bookmark of bookmarks) {
        const info = cache.get(bookmark);
        if (!info) {
            continue;
        }
        let contentSynced: boolean | undefined;
        if (commitId) {
            contentSynced =
                commitId === info.currentRevision
                    ? true
                    : (contentSyncCache.get(`${commitId}:${info.currentRevision ?? ''}`) ?? false);
        }
        return { ...info, contentSynced };
    }
    return undefined;
}

export interface ResolveBookmarkSyncOptions {
    provider: CodeForgeProvider;
    info: CodeForgeChangeInfo;
    matchingChanges: readonly ChangeStatusRequest[];
    jj: JjService;
    contentSyncCache: LruCache<string, boolean>;
    normalizeDescription: (description: string) => string;
}

/**
 * Hydrates Tier-1 uploaded file metadata from the local store (when available) and updates
 * rebase-aware `contentSynced` cache entries across matching bookmark commits.
 */
export async function resolveUploadedAndVerifyBookmarkSync(options: ResolveBookmarkSyncOptions): Promise<boolean> {
    const { provider, info, matchingChanges, jj, contentSyncCache, normalizeDescription } = options;
    if (info.status === 'NEW' && info.currentRevision && info.files === undefined) {
        const localDetails = await resolveLocalUploadedDetails(info, jj, provider.uploadModel).catch(() => undefined);
        if (localDetails) {
            info.files = localDetails.files;
            if (info.remoteDescription === undefined && localDetails.remoteDescription !== undefined) {
                info.remoteDescription = localDetails.remoteDescription;
            }
        }
    }

    let syncChanged = false;
    for (const change of matchingChanges) {
        const syncCacheKey = `${change.commitId}:${info.currentRevision ?? ''}`;
        const prevSync = contentSyncCache.get(syncCacheKey);
        let synced = change.commitId === info.currentRevision;
        if (!synced && info.status === 'NEW' && info.files) {
            try {
                let localBaseCommitId: string | undefined;
                if (info.remoteBaseRevision) {
                    const [logEntry] = await jj.getLog({ revision: change.commitId, limit: 1, omitChanges: true });
                    if (logEntry) {
                        const scope = await resolveLocalBranchComparisonScope(
                            jj,
                            logEntry,
                            info,
                            provider,
                            change.changes,
                        );
                        localBaseCommitId = scope.localBaseCommitId;
                    }
                }
                const verified = await verifyLocalContentSync({
                    commitId: change.commitId,
                    description: change.description,
                    info,
                    jj,
                    changes: change.changes,
                    normalizeDescription,
                    localBaseCommitId,
                });
                synced = verified ?? false;
            } catch {
                synced = false;
            }
        }
        contentSyncCache.set(syncCacheKey, synced);
        if (prevSync !== synced) {
            syncChanged = true;
        }
    }
    return syncChanged;
}
