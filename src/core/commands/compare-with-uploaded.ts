/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripGerritTrailers } from '../../utils/gerrit-utils';
import {
    areUint8ArraysEqual,
    resolveLocalBranchComparisonScope,
    resolveLocalUploadedDetails,
} from '../code-forge-sync-utils';
import type { CommandContext } from '../host/command-context';
import type { MultiDiffResource } from '../host/host-environment';
import { showJjError } from '../host/ui-helpers';
import type { JjRepository } from '../jj-repository';
import type { CodeForgeChangeInfo, JjLogEntry, JjStatusEntry } from '../jj-schemas';
import {
    createDiffUris,
    createRepoFileUri,
    createRevisionUri,
    createTextContentUri,
    createUploadedFileUri,
    type Uri,
} from '../uri-utils';

export interface CompareWithUploadedPayload {
    revision?: string;
    changeId?: string;
}

export interface ComputeUnuploadedComparisonOptions {
    logEntry?: JjLogEntry;
    localChanges?: readonly JjStatusEntry[];
}

export type UnuploadedComparisonResource = MultiDiffResource;

export interface UnuploadedComparisonResult {
    changeId: string;
    commitId: string;
    shortChangeId: string;
    displayLabel: string;
    descriptionModified: boolean;
    localDescription: string;
    remoteDescription?: string;
    resources: UnuploadedComparisonResource[];
    unuploadedFilePaths: string[];
    isContentSynced: boolean;
    codeForgeChange: CodeForgeChangeInfo;
}

async function compareUploadedFileBytes(
    repo: JjRepository,
    info: CodeForgeChangeInfo,
    logEntry: JjLogEntry,
    remoteRevision: string,
    filePath: string,
    remoteSha?: string,
): Promise<{ hasDiff: boolean; isLocalMissing: boolean }> {
    const localRev = logEntry.is_current_working_copy ? '@' : logEntry.commit_id;
    let localBytes: Uint8Array;
    try {
        localBytes = await repo.jj.getFileBinaryContent(filePath, localRev);
    } catch {
        return { hasDiff: true, isLocalMissing: true };
    }

    let remoteBytes: Uint8Array | undefined;
    try {
        remoteBytes = await repo.jj.getFileBinaryContent(filePath, remoteRevision);
    } catch {
        remoteBytes = await repo.codeForge?.getUploadedFileContent?.({
            changeId: info.id || logEntry.change_id,
            changeNumber: info.number,
            revisionId: remoteRevision,
            filePath,
            blobSha: remoteSha,
        });
    }

    if (remoteBytes === undefined) {
        return { hasDiff: true, isLocalMissing: false };
    }

    return {
        hasDiff: !areUint8ArraysEqual(localBytes, remoteBytes),
        isLocalMissing: false,
    };
}

/**
 * Computes the file and description diffs between a local revision and its uploaded Code Forge revision.
 * Scoped strictly to the files touched by the change (localChanges ∪ remoteFiles) and COMMIT_MSG, avoiding unrelated
 * upstream rebase diffs.
 *
 * @param repo - The Jujutsu repository instance
 * @param revision - The revision identifier (commit ID, change ID, bookmark, or `@`)
 * @returns Object containing comparison resources, modified status, and file paths
 * @throws Error if the revision does not exist, lacks an uploaded change link, or has no remote revision
 */
export async function computeUnuploadedComparison(
    repo: JjRepository,
    revision: string,
    options?: ComputeUnuploadedComparisonOptions,
): Promise<UnuploadedComparisonResult> {
    const { jj } = repo;
    let logEntry: JjLogEntry | undefined = options?.logEntry ? { ...options.logEntry } : undefined;
    if (!logEntry) {
        const [fetched] = await jj.getLog({ revision, limit: 1, omitChanges: false });
        logEntry = fetched;
    }
    if (!logEntry) {
        throw new Error(`Revision ${revision} not found.`);
    }

    if (!logEntry.codeForgeChange && repo.codeForge) {
        repo.codeForge.populateCodeForgeInfo([logEntry]);
        if (!logEntry.codeForgeChange) {
            await repo.codeForge.detectActiveProvider?.();
            await repo.codeForge.ensureFreshStatuses?.([
                {
                    commitId: logEntry.commit_id,
                    changeId: logEntry.change_id,
                    description: logEntry.description,
                    bookmarks: (logEntry.bookmarks ?? []).filter((b) => !b.remote).map((b) => b.name),
                    parents: logEntry.parents,
                    changes: options?.localChanges ? [...options.localChanges] : logEntry.changes,
                },
            ]);
            repo.codeForge.populateCodeForgeInfo([logEntry]);
        }
    }

    const info = logEntry.codeForgeChange;
    if (!info) {
        throw new Error(
            `Revision ${logEntry.change_id_shortest ?? logEntry.change_id} is not linked to an uploaded change.`,
        );
    }

    const remoteRevision = info.currentRevision;
    if (!remoteRevision) {
        throw new Error(`No uploaded remote revision recorded for ${info.displayLabel || logEntry.change_id}.`);
    }

    const activeProvider = repo.codeForge?.activeProvider;
    let uploadedDetails = await resolveLocalUploadedDetails(info, jj, activeProvider?.uploadModel);
    if (!uploadedDetails && repo.codeForge?.fetchUploadedRevisionDetails) {
        uploadedDetails = await repo.codeForge.fetchUploadedRevisionDetails(info);
    }
    if (!uploadedDetails) {
        throw new Error(`Uploaded file metadata is not available for ${info.displayLabel || logEntry.change_id}.`);
    }

    const normalizeDescription = (description: string): string => {
        if (repo.codeForge?.normalizeDescription) {
            return repo.codeForge.normalizeDescription(description);
        }
        return info.providerName === 'Gerrit' ? stripGerritTrailers(description) : description.trim();
    };

    const localDescription = logEntry.description || '';
    const remoteDescription = uploadedDetails.remoteDescription ?? info.remoteDescription;
    const descriptionModified = Boolean(
        remoteDescription !== undefined &&
            normalizeDescription(localDescription) !== normalizeDescription(remoteDescription),
    );

    const resources: UnuploadedComparisonResource[] = [];
    const unuploadedFilePaths: string[] = [];
    const platform = jj.system.platform;

    // 1. Commit message diff (synthetic COMMIT_MSG file, similar to code forge UI)
    if (descriptionModified && remoteDescription !== undefined) {
        const leftUri = createTextContentUri(jj.workspaceRoot, 'COMMIT_MSG', remoteDescription, platform);
        const rightUri = createTextContentUri(jj.workspaceRoot, 'COMMIT_MSG', localDescription, platform);
        resources.push({
            leftUri,
            rightUri,
            label: 'COMMIT_MSG',
        });
    }

    // 2. File changes
    const { localChanges, localBaseCommitId } = await resolveLocalBranchComparisonScope(
        jj,
        logEntry,
        info,
        activeProvider,
        options?.localChanges,
    );
    const remoteFiles = uploadedDetails.files;
    const localChangeMap = new Map(localChanges.map((c) => [c.path, c]));
    const impliedRemoteDeletes = new Set<string>();
    for (const remoteFile of Object.values(remoteFiles)) {
        if (remoteFile.status === 'R' && remoteFile.oldPath && !(remoteFile.oldPath in remoteFiles)) {
            impliedRemoteDeletes.add(remoteFile.oldPath);
        }
    }

    const allPathsSet = new Set<string>([
        ...localChangeMap.keys(),
        ...Object.keys(remoteFiles),
        ...impliedRemoteDeletes,
    ]);
    const allPaths = Array.from(allPathsSet).sort();

    const hasGitBackend = (await jj.getGitRoot()) !== null;
    const localBlobHashes = hasGitBackend
        ? await jj.getGitBlobHashes(logEntry.commit_id, allPaths)
        : new Map<string, string>();

    for (const filePath of allPaths) {
        const localChange = localChangeMap.get(filePath);
        const remoteFile = remoteFiles[filePath];
        const localSha = localBlobHashes.get(filePath);
        const remoteSha = remoteFile?.newSha;
        const isLocalDeleted = localChange?.status === 'deleted';
        const isRemoteDeleted =
            remoteFile?.status === 'D' || (remoteFile === undefined && impliedRemoteDeletes.has(filePath));
        let isLocalMissing = isLocalDeleted || (hasGitBackend && !localChange && !localSha);

        // Check if the file content or existence actually differs between local and remote
        let hasDiff = false;
        if (isLocalMissing && isRemoteDeleted) {
            hasDiff = false;
        } else if (isLocalMissing !== isRemoteDeleted) {
            hasDiff = true;
        } else if (remoteFile === undefined) {
            // Added or modified locally, but was not present in the uploaded revision
            hasDiff = true;
        } else if (hasGitBackend && localSha && remoteSha) {
            hasDiff = localSha !== remoteSha;
        } else if (hasGitBackend && !localChange && !localSha) {
            hasDiff = true;
        } else if (!hasGitBackend || !remoteSha) {
            const byteComparison = await compareUploadedFileBytes(
                repo,
                info,
                logEntry,
                remoteRevision,
                filePath,
                remoteSha,
            );
            hasDiff = byteComparison.hasDiff;
            if (byteComparison.isLocalMissing) {
                isLocalMissing = true;
            }
        } else {
            hasDiff = true;
        }

        if (!hasDiff) {
            continue;
        }

        unuploadedFilePaths.push(filePath);

        // Build left URI (Uploaded remote revision)
        let leftUri: Uri;
        if (isRemoteDeleted || (!remoteFile && localChange?.status === 'added')) {
            leftUri = createRevisionUri(jj.workspaceRoot, filePath, 'none', platform);
        } else if (!remoteFile && localChange) {
            // File was modified locally but not present in remote: compare against local branch base
            if (localBaseCommitId) {
                leftUri = createRevisionUri(
                    jj.workspaceRoot,
                    localChange.oldPath ?? localChange.path,
                    localBaseCommitId,
                    platform,
                );
            } else {
                const diffUris = createDiffUris(localChange, logEntry.commit_id, jj.workspaceRoot, {
                    editable: false,
                    platform,
                });
                leftUri = diffUris.leftUri;
            }
        } else {
            leftUri = createUploadedFileUri(jj.workspaceRoot, filePath, {
                changeId: info.id || logEntry.change_id,
                commitId: remoteRevision,
                blobSha: remoteSha,
                remoteRevision,
                changeNumber: info.number,
                platform,
            });
        }

        // Build right URI (Local revision)
        let rightUri: Uri;
        if (isLocalMissing) {
            rightUri = createRevisionUri(jj.workspaceRoot, filePath, 'none', platform);
        } else if (logEntry.is_current_working_copy) {
            rightUri = createRepoFileUri(jj.workspaceRoot, filePath, 'file', { platform });
        } else {
            rightUri = createRevisionUri(jj.workspaceRoot, filePath, logEntry.commit_id, platform);
        }

        const oldLabel =
            !remoteFile && localChange && (localChange.status === 'renamed' || localChange.status === 'copied')
                ? localChange.oldPath
                : undefined;
        const status = isLocalMissing
            ? 'deleted'
            : isRemoteDeleted || (!remoteFile && localChange?.status === 'added')
              ? 'added'
              : oldLabel
                ? localChange?.status
                : 'modified';
        resources.push({
            leftUri,
            rightUri,
            label: filePath,
            ...(oldLabel ? { oldLabel } : {}),
            status,
        });
    }

    const shortChangeId = logEntry.change_id_shortest ?? logEntry.change_id.slice(0, 8);
    const displayLabel =
        info.displayLabel || `${activeProvider?.changeTerm ?? 'Change'} ${info.number || shortChangeId}`;

    return {
        changeId: logEntry.change_id,
        commitId: logEntry.commit_id,
        shortChangeId,
        displayLabel,
        descriptionModified,
        localDescription,
        remoteDescription,
        resources,
        unuploadedFilePaths,
        isContentSynced: resources.length === 0,
        codeForgeChange: info,
    };
}

export async function compareWithUploadedCommand(
    ctx: CommandContext,
    payload?: CompareWithUploadedPayload,
): Promise<void> {
    try {
        const revision = payload?.revision || payload?.changeId || '@';

        await ctx.host.ui.withProgress(`Comparing ${revision} with uploaded revision...`, async (): Promise<void> => {
            const result = await computeUnuploadedComparison(ctx.repo, revision);

            if (result.resources.length === 0) {
                if (result.codeForgeChange.parentSynced === false) {
                    await ctx.host.ui.showInformation(
                        `Content of ${result.shortChangeId} matches uploaded revision. (Only parent revisions differ due to rebase.)`,
                    );
                } else {
                    await ctx.host.ui.showInformation(
                        `Revision ${result.shortChangeId} is up to date with uploaded revision ${result.displayLabel}.`,
                    );
                }
                return;
            }

            const title = `Uploaded vs Local: ${result.shortChangeId} (${result.displayLabel})`;
            await ctx.host.nav.openMultiDiff(title, result.resources);
        });
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Failed to compare with uploaded revision', ctx.repo.jj, ctx.log);
    }
}
