/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'pathe';
import {
    formatRemoteFileUrl,
    type RemoteLineRange,
    resolveRemoteTarget,
    toOneBasedLineRange,
} from '../../utils/remote-url-utils';
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import type { JjService } from '../jj-service';
import {
    decodeJjViewQuery,
    getFsPathFromUri,
    getRevisionFromUri,
    getUriParams,
    toForwardSlash,
    Uri,
} from '../uri-utils';

export interface RemoteFileUrlPayload {
    /** File or diff/revision URI (`file://`, `jj-view://`, or `jj-edit://`). */
    fileUri?: Uri;
    /** Explicit file path (e.g. from Commit Details file context menu). */
    filePath?: string;
    /** Whether `filePath` is already relative to the Jujutsu repository root. */
    isRepoRelative?: boolean;
    /** Target revision ID or change ID (when not targeting the working copy). */
    revision?: string;
    /** Status of the file in the target revision (e.g. `'deleted'`). */
    fileStatus?: string;
    /** Explicit 1-based line or range anchor. */
    lineRange?: RemoteLineRange;
    /** Prevents falling back to active editor selections (e.g. Explorer/SCM/Commit Details context menus). */
    skipActiveSelection?: boolean;
}

const ZERO_COMMIT_ID_REGEX = /^0+$/;
const GIT_HEX_SHA_REGEX = /^[0-9a-fA-F]{7,64}$/;

function isZeroCommitId(commitId: string): boolean {
    return ZERO_COMMIT_ID_REGEX.test(commitId.trim());
}

async function isNonRootRevision(jj: JjService, revset: string): Promise<boolean> {
    const ids = await jj.getLogIds({ revision: `(${revset}) ~ root()`, limit: 1 });
    return ids.length > 0;
}

/**
 * Resolves a single deterministic non-root parent commit SHA for `revision` (handling merge commits).
 * Returns `undefined` if all parents are `root()`.
 */
async function resolveParentRevision(jj: JjService, revision: string): Promise<string | undefined> {
    const entries = await jj.getLog({ revision, limit: 2, omitChanges: true });
    if (entries.length === 0) {
        throw new Error(`Revision '${revision}' could not be found.`);
    }
    if (entries.length > 1) {
        throw new Error(`Revision '${revision}' matches multiple commits.`);
    }
    const target = entries[0];
    if (isZeroCommitId(target.commit_id)) {
        return undefined;
    }

    const parentExpr = `(${target.commit_id})-`;
    const nonRootParents = await jj.getLogIds({ revision: `${parentExpr} ~ root()`, limit: 1 });
    if (!nonRootParents[0]) {
        return undefined;
    }

    const remoteAncestors = await jj.getLogIds({
        revision: `heads(::(${parentExpr}) & ::remote_bookmarks() & ~root())`,
        limit: 1,
    });
    if (remoteAncestors[0]) {
        return remoteAncestors[0];
    }

    const immutableAncestors = await jj.getLogIds({
        revision: `heads((${parentExpr}) & immutable() & ~root())`,
        limit: 1,
    });
    return immutableAncestors[0] ?? nonRootParents[0];
}

/**
 * Resolves the remote-reachable commit SHA for either the working copy or a specific revision.
 */
export async function resolveCommitShaForRemoteLink(jj: JjService, revision?: string): Promise<string | undefined> {
    const trimmedRevision = revision?.trim();
    if (!trimmedRevision || trimmedRevision === '@') {
        return await resolveWorkingCopyCommitSha(jj);
    }

    const entries = await jj.getLog({ revision: trimmedRevision, limit: 2, omitChanges: true });
    if (entries.length === 0) {
        throw new Error(`Revision '${trimmedRevision}' could not be found.`);
    }
    if (entries.length > 1) {
        throw new Error(`Revision '${trimmedRevision}' matches multiple commits.`);
    }

    const target = entries[0];
    if (isZeroCommitId(target.commit_id)) {
        return undefined;
    }

    if (target.is_current_working_copy) {
        return await resolveWorkingCopyCommitSha(jj);
    }

    if (target.is_immutable) {
        return target.commit_id;
    }

    const onRemote = await jj.getLogIds({
        revision: `(${target.commit_id}) & ::remote_bookmarks()`,
        limit: 1,
    });
    if (onRemote[0]) {
        return target.commit_id;
    }

    const remoteAncestors = await jj.getLogIds({
        revision: `heads(::(${target.commit_id}) & ::remote_bookmarks() & ~root())`,
        limit: 1,
    });
    if (remoteAncestors[0]) {
        return remoteAncestors[0];
    }

    const immutableAncestors = await jj.getLogIds({
        revision: `heads(::(${target.commit_id}) & immutable() & ~root())`,
        limit: 1,
    });
    if (immutableAncestors[0]) {
        return immutableAncestors[0];
    }

    return target.commit_id;
}

async function resolveWorkingCopyCommitSha(jj: JjService): Promise<string | undefined> {
    const remoteAncestors = await jj.getLogIds({
        revision: 'heads(::@ & ::remote_bookmarks() & ~root())',
        limit: 1,
    });
    if (remoteAncestors[0]) {
        return remoteAncestors[0];
    }

    const immutableAncestors = await jj.getLogIds({
        revision: 'heads(::@- & immutable() & ~root())',
        limit: 1,
    });
    if (immutableAncestors[0]) {
        return immutableAncestors[0];
    }

    const parents = await jj.getLogIds({ revision: '@- ~ root()', limit: 1 });
    if (parents[0]) {
        return parents[0];
    }

    const workingCopy = await jj.getLogIds({ revision: '@ ~ root()', limit: 1 });
    return workingCopy[0];
}

interface ResolvedFileTarget {
    relativePath: string;
    revision?: string;
    directCommitSha?: string;
}

async function adjustRevisionForDeletedFile(
    ctx: CommandContext,
    revision: string | undefined,
    fileStatus: string | undefined,
): Promise<{ revision?: string; aborted: boolean }> {
    const { jj } = ctx.repo;
    if (!revision || fileStatus !== 'deleted') {
        return { revision, aborted: false };
    }
    if (await isRevisionWorkingCopy(jj, revision)) {
        return { revision, aborted: false };
    }
    const parentSha = await resolveParentRevision(jj, revision);
    if (!parentSha) {
        void ctx.host.ui.showWarning('Cannot generate a remote file link for the root commit.');
        return { aborted: true };
    }
    return { revision: parentSha, aborted: false };
}

async function resolveValidatedRepoRelativePath(
    ctx: CommandContext,
    fsPath: string,
    label: string,
): Promise<string | undefined> {
    const relativePath = await ctx.repo.jj.resolveRepoRelativePath(fsPath);
    if (relativePath === undefined) {
        void ctx.host.ui.showWarning(`File '${label}' is outside the Jujutsu repository.`);
        return undefined;
    }
    if (relativePath.length === 0) {
        void ctx.host.ui.showWarning('Select a file rather than a folder to link on the remote.');
        return undefined;
    }
    return relativePath;
}

async function resolveTargetFromUri(
    ctx: CommandContext,
    uri: Uri,
    explicitRevision?: string,
    fileStatus?: string,
): Promise<ResolvedFileTarget | undefined> {
    const { jj } = ctx.repo;

    if (uri.scheme === 'file') {
        const relativePath = await resolveValidatedRepoRelativePath(ctx, uri.fsPath, path.basename(uri.fsPath));
        if (!relativePath) {
            return undefined;
        }

        const repoRoot = await jj.getRepoRoot();
        const stat = await ctx.host.system?.fs.stat(path.join(repoRoot, relativePath)).catch(() => undefined);
        if (stat?.isDirectory()) {
            void ctx.host.ui.showWarning('Select a file rather than a folder to link on the remote.');
            return undefined;
        }

        const adjusted = await adjustRevisionForDeletedFile(ctx, explicitRevision, fileStatus);
        if (adjusted.aborted) {
            return undefined;
        }
        return { relativePath, revision: adjusted.revision };
    }

    if (uri.scheme !== 'jj-view' && uri.scheme !== 'jj-edit') {
        void ctx.host.ui.showWarning('Open or select a repository file to generate a remote link.');
        return undefined;
    }

    const fsPath = getFsPathFromUri(uri);
    const relativePath = await resolveValidatedRepoRelativePath(ctx, fsPath, path.basename(uri.path));
    if (!relativePath) {
        return undefined;
    }

    if (uri.scheme === 'jj-edit') {
        const rawRevision = explicitRevision || getRevisionFromUri(uri);
        const adjusted = await adjustRevisionForDeletedFile(ctx, rawRevision, fileStatus);
        if (adjusted.aborted) {
            return undefined;
        }
        return { relativePath, revision: adjusted.revision };
    }

    const params = getUriParams(uri);
    let query: ReturnType<typeof decodeJjViewQuery> | undefined;
    try {
        query = decodeJjViewQuery(uri);
    } catch {
        query = undefined;
    }

    if (!query) {
        const fallbackRev = explicitRevision || params.get('jj-revision');
        if (!fallbackRev) {
            void ctx.host.ui.showWarning('Could not parse revision information from document URI.');
            return undefined;
        }
        const adjusted = await adjustRevisionForDeletedFile(ctx, fallbackRev, fileStatus);
        if (adjusted.aborted) {
            return undefined;
        }
        return { relativePath, revision: adjusted.revision };
    }

    if (query.mode === 'text') {
        void ctx.host.ui.showWarning('Cannot generate a remote link for a virtual text document.');
        return undefined;
    }

    if (query.mode === 'diff') {
        if (query.side === 'left') {
            const parentSha = await resolveParentRevision(jj, query.base);
            if (!parentSha) {
                void ctx.host.ui.showWarning('Cannot generate a remote file link for the root commit.');
                return undefined;
            }
            return { relativePath, revision: parentSha };
        }

        let rightStatus = fileStatus;
        if (rightStatus === undefined && !(await isRevisionWorkingCopy(jj, query.base))) {
            const existsInBase = await jj.hasFileAtRevision(relativePath, query.base);
            if (!existsInBase) {
                rightStatus = 'deleted';
            }
        }
        const adjusted = await adjustRevisionForDeletedFile(ctx, query.base, rightStatus);
        if (adjusted.aborted) {
            return undefined;
        }
        return { relativePath, revision: adjusted.revision };
    }

    if (query.mode === 'uploaded') {
        const uploadedRev = query.commitId || query.remoteRevision || query.changeId;
        if (!uploadedRev) {
            void ctx.host.ui.showWarning('Could not resolve a remote revision for the uploaded file.');
            return undefined;
        }
        if (GIT_HEX_SHA_REGEX.test(uploadedRev)) {
            return { relativePath, directCommitSha: uploadedRev };
        }
        return { relativePath, revision: uploadedRev };
    }

    if (query.revision === 'none') {
        void ctx.host.ui.showWarning('File does not exist in this revision.');
        return undefined;
    }

    const rawRevision = explicitRevision || params.get('jj-revision') || query.revision;
    const adjusted = await adjustRevisionForDeletedFile(ctx, rawRevision, fileStatus);
    if (adjusted.aborted) {
        return undefined;
    }
    return { relativePath, revision: adjusted.revision };
}

async function resolveFileTarget(
    ctx: CommandContext,
    payload?: RemoteFileUrlPayload,
): Promise<ResolvedFileTarget | undefined> {
    if (payload?.filePath) {
        const normalizedPath = payload.isRepoRelative
            ? toForwardSlash(payload.filePath).replace(/^\/+|\/+$/g, '')
            : await resolveValidatedRepoRelativePath(ctx, payload.filePath, path.basename(payload.filePath));

        if (!normalizedPath) {
            if (payload.isRepoRelative) {
                void ctx.host.ui.showWarning(
                    `File '${path.basename(payload.filePath)}' is outside the Jujutsu repository.`,
                );
            }
            return undefined;
        }

        const adjusted = await adjustRevisionForDeletedFile(ctx, payload.revision, payload.fileStatus);
        if (adjusted.aborted) {
            return undefined;
        }
        return { relativePath: normalizedPath, revision: adjusted.revision };
    }

    if (payload?.fileUri) {
        return await resolveTargetFromUri(ctx, payload.fileUri, payload.revision, payload.fileStatus);
    }

    const activeUri = ctx.host.documents?.getActiveDocumentUri?.();
    if (activeUri) {
        return await resolveTargetFromUri(ctx, activeUri, payload?.revision, payload?.fileStatus);
    }

    void ctx.host.ui.showWarning('No file selected to link on the remote.');
    return undefined;
}

async function isRevisionWorkingCopy(jj: JjService, revision: string): Promise<boolean> {
    if (revision === '@') {
        return true;
    }
    const entries = await jj.getLog({ revision, limit: 2, omitChanges: true });
    return entries.length === 1 && Boolean(entries[0].is_current_working_copy);
}

function resolveLineRange(ctx: CommandContext, payload?: RemoteFileUrlPayload): RemoteLineRange | undefined {
    if (payload?.lineRange) {
        return payload.lineRange;
    }
    if (payload?.skipActiveSelection || !ctx.host.documents?.getActiveDocumentSelections) {
        return undefined;
    }

    const targetUri = payload?.fileUri ?? ctx.host.documents.getActiveDocumentUri?.();
    const activeUri = ctx.host.documents.getActiveDocumentUri?.();
    if (!targetUri || !activeUri || targetUri.toString() !== activeUri.toString()) {
        return undefined;
    }

    const selections = ctx.host.documents.getActiveDocumentSelections();
    if (!selections || selections.length === 0) {
        return undefined;
    }
    return toOneBasedLineRange(selections[0]);
}

/**
 * Resolves the full remote forge URL (GitHub, GitLab, or Gerrit/Gitiles) for a file at its
 * matching pushed/immutable or specified revision.
 */
export async function resolveRemoteFileUrl(
    ctx: CommandContext,
    payload?: RemoteFileUrlPayload,
): Promise<{ url: string; relativePath: string } | undefined> {
    const fileTarget = await resolveFileTarget(ctx, payload);
    if (!fileTarget) {
        return undefined;
    }

    const { jj } = ctx.repo;
    const gerritHost = ctx.host.config.get<string>('gerrit.host');
    const gerritProject = ctx.host.config.get<string>('gerrit.project');
    const gitlabHost = ctx.host.config.get<string>('gitlab.host');

    const remotes = await jj.getGitRemotes();
    const preferredRemote = remotes.find((r) => r.name === 'origin') ?? remotes[0];

    if (!preferredRemote && !gerritHost?.trim()) {
        void ctx.host.ui.showWarning('No Git remote is configured for this repository.');
        return undefined;
    }

    const gitWebUrl = preferredRemote ? await jj.getGitWebUrl(preferredRemote.name) : undefined;
    const remoteTarget = resolveRemoteTarget({
        gitWebUrl,
        remoteUrl: preferredRemote?.url,
        settings: { gerritHost, gerritProject, gitlabHost },
    });
    if (!remoteTarget) {
        void ctx.host.ui.showWarning('Could not determine a remote web URL for this repository.');
        return undefined;
    }

    let commitSha = fileTarget.directCommitSha;
    if (!commitSha) {
        if (fileTarget.revision) {
            const nonRoot = await isNonRootRevision(jj, fileTarget.revision);
            if (!nonRoot) {
                void ctx.host.ui.showWarning('Cannot generate a remote file link for the root commit.');
                return undefined;
            }
        }

        commitSha = await resolveCommitShaForRemoteLink(jj, fileTarget.revision);
        if (!commitSha) {
            void ctx.host.ui.showWarning('Could not find a non-root commit to link on the remote.');
            return undefined;
        }
    }

    const lineRange = resolveLineRange(ctx, payload);
    const url = formatRemoteFileUrl({
        target: remoteTarget,
        commitSha,
        relativePath: fileTarget.relativePath,
        lineRange,
    });
    return { url, relativePath: fileTarget.relativePath };
}

export async function openFileOnRemoteCommand(ctx: CommandContext, payload?: RemoteFileUrlPayload): Promise<void> {
    try {
        const resolved = await resolveRemoteFileUrl(ctx, payload);
        if (!resolved) {
            return;
        }
        await ctx.host.nav.openExternal(Uri.parse(resolved.url));
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Failed to open file on remote', ctx.repo.jj, ctx.log);
    }
}

export async function copyRemoteFileUrlCommand(ctx: CommandContext, payload?: RemoteFileUrlPayload): Promise<void> {
    try {
        const resolved = await resolveRemoteFileUrl(ctx, payload);
        if (!resolved) {
            return;
        }
        await ctx.host.nav.copyToClipboard(resolved.url);
        void ctx.host.ui.showInformation(`Copied remote link for ${resolved.relativePath}.`);
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Failed to copy remote file link', ctx.repo.jj, ctx.log);
    }
}
