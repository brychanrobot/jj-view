/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'pathe';
import { stripGerritTrailers } from '../../utils/gerrit-utils';
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import type { JjRepository } from '../jj-repository';
import type { CodeForgeChangeInfo } from '../jj-schemas';
import { createDiffUris, createRevisionUri, createTextContentUri, createUploadedFileUri, Uri } from '../uri-utils';

export interface CompareWithUploadedPayload {
    revision?: string;
    changeId?: string;
}

export interface UnuploadedComparisonResource {
    leftUri: Uri;
    rightUri: Uri;
    label: string;
}

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

/**
 * Computes the file and description diffs between a local revision and its uploaded Code Forge revision.
 * Scoped strictly to the files touched by the CL (localChanges ∪ remoteFiles) and COMMIT_MSG, avoiding unrelated
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
): Promise<UnuploadedComparisonResult> {
    const { jj } = repo;
    const [logEntry] = await jj.getLog({ revision, limit: 1, omitChanges: false });
    if (!logEntry) {
        throw new Error(`Revision ${revision} not found.`);
    }

    if (repo.codeForge) {
        repo.codeForge.populateCodeForgeInfo([logEntry]);
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

    const localDescription = logEntry.description || '';
    const remoteDescription = info.remoteDescription;
    const descriptionModified = Boolean(
        remoteDescription && stripGerritTrailers(localDescription) !== stripGerritTrailers(remoteDescription),
    );

    const resources: UnuploadedComparisonResource[] = [];
    const unuploadedFilePaths: string[] = [];

    // 1. Commit message diff (synthetic COMMIT_MSG file, similar to code forge UI)
    if (descriptionModified && remoteDescription) {
        const leftUri = createTextContentUri(jj.workspaceRoot, 'COMMIT_MSG', remoteDescription);
        const rightUri = createTextContentUri(jj.workspaceRoot, 'COMMIT_MSG', localDescription);
        resources.push({
            leftUri,
            rightUri,
            label: 'COMMIT_MSG',
        });
    }

    // 2. File changes
    const localChanges = await jj.getChanges(logEntry.commit_id);
    const remoteFiles = info.files || {};
    const localChangeMap = new Map(localChanges.map((c) => [c.path, c]));

    const allPathsSet = new Set<string>([...localChangeMap.keys(), ...Object.keys(remoteFiles)]);
    const allPaths = Array.from(allPathsSet).sort();

    const localBlobHashes = await jj.getGitBlobHashes(logEntry.commit_id, allPaths);

    for (const filePath of allPaths) {
        const localChange = localChangeMap.get(filePath);
        const remoteFile = remoteFiles[filePath];
        const localSha = localBlobHashes.get(filePath);
        const remoteSha = remoteFile?.newSha;
        const isLocalDeleted = localChange?.status === 'deleted';
        const isRemoteDeleted = remoteFile?.status === 'D';

        // Check if the file content or existence actually differs between local and remote
        let hasDiff = false;
        if (isLocalDeleted && isRemoteDeleted) {
            hasDiff = false;
        } else if (isLocalDeleted !== isRemoteDeleted) {
            hasDiff = true;
        } else if (remoteFile === undefined) {
            // Added or modified locally, but was not present in the uploaded revision
            hasDiff = true;
        } else if (localChange === undefined) {
            // In remote revision, but not modified in this local commit compared to local parent
            if (localSha && remoteSha && localSha === remoteSha) {
                hasDiff = false;
            } else {
                hasDiff = true;
            }
        } else if (localSha && remoteSha) {
            hasDiff = localSha !== remoteSha;
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
            leftUri = createRevisionUri(jj.workspaceRoot, filePath, 'none');
        } else if (!remoteFile && localChange) {
            // File was modified locally but not present in remote: compare against local parent base
            const diffUris = createDiffUris(localChange, logEntry.commit_id, jj.workspaceRoot, { editable: false });
            leftUri = diffUris.leftUri;
        } else {
            leftUri = createUploadedFileUri(jj.workspaceRoot, filePath, {
                changeId: logEntry.change_id,
                commitId: remoteRevision,
                blobSha: remoteSha,
                remoteRevision,
                changeNumber: info.number,
            });
        }

        // Build right URI (Local revision)
        let rightUri: Uri;
        if (isLocalDeleted) {
            rightUri = createRevisionUri(jj.workspaceRoot, filePath, 'none');
        } else if (logEntry.is_current_working_copy) {
            rightUri = Uri.file(path.resolve(jj.workspaceRoot, filePath));
        } else {
            rightUri = createRevisionUri(jj.workspaceRoot, filePath, logEntry.commit_id);
        }

        resources.push({
            leftUri,
            rightUri,
            label: filePath,
        });
    }

    const shortChangeId = logEntry.change_id_shortest ?? logEntry.change_id.slice(0, 8);
    const displayLabel = info.displayLabel || `CL/${info.number || shortChangeId}`;

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
