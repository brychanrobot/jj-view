/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import type { JjStatusEntry } from '../jj-types';
import { normalizeRepoSeparators, pathIsAbsolute, pathNormalize, pathResolve } from '../path-utils';
import { getFsPathFromUri, getRevisionFromUri, isInsideRelativePath, Uri } from '../uri-utils';
import { resolveWorkspaceRelativePath } from './command-utils';

export interface SplitFilesPayload {
    paths: string[];
    revision?: string;
    validationError?: string;
}

async function normalizeWorkspaceFilePath(ctx: CommandContext, inputPath: string): Promise<string> {
    const workspaceRoot = ctx.repo.jj.workspaceRoot;
    const platform = ctx.repo.jj.system.platform;
    let rel: string;
    if (pathIsAbsolute(inputPath, platform)) {
        const resolved = await resolveWorkspaceRelativePath(workspaceRoot, inputPath, ctx.host.system?.fs, platform);
        if (resolved === undefined) {
            throw new Error(`Selected file is outside the repository workspace: ${inputPath}`);
        }
        rel = resolved;
    } else {
        rel = pathNormalize(inputPath, platform);
    }

    const normalized = normalizeRepoSeparators(rel, platform);
    if (normalized === '' || normalized === '.' || !isInsideRelativePath(normalized, platform)) {
        throw new Error(`Invalid file path for split: ${inputPath}`);
    }
    return normalized;
}

async function flushDirtySplitDocuments(
    ctx: CommandContext,
    options: {
        targetPaths: readonly string[];
        isWorkingCopy: boolean;
        revisionAliases: ReadonlySet<string>;
    },
): Promise<boolean> {
    const platform = ctx.repo.jj.system.platform;
    if (options.isWorkingCopy) {
        for (const relPath of options.targetPaths) {
            await ctx.host.documents.saveIfDirty(Uri.file(pathResolve([ctx.repo.jj.workspaceRoot, relPath], platform)));
        }
    }

    const openUris = ctx.host.documents.getOpenDocumentUris?.() ?? [];
    if (openUris.length === 0) {
        return false;
    }

    const targetAbsPaths = new Set(
        options.targetPaths.map((relPath) =>
            pathNormalize(pathResolve([ctx.repo.jj.workspaceRoot, relPath], platform), platform),
        ),
    );
    let flushedJjEdit = false;
    for (const openUri of openUris) {
        if (openUri.scheme !== 'jj-edit') {
            continue;
        }
        const openRev = getRevisionFromUri(openUri)?.trim();
        if (openRev && !options.revisionAliases.has(openRev)) {
            continue;
        }
        const openFsPath = pathNormalize(getFsPathFromUri(openUri, platform), platform);
        if (!targetAbsPaths.has(openFsPath)) {
            continue;
        }
        await ctx.host.documents.saveIfDirty(openUri);
        flushedJjEdit = true;
    }
    return flushedJjEdit;
}

async function splitFiles(
    ctx: CommandContext,
    options: { revision: string; paths: string[]; validationError?: string },
    placement: 'before' | 'after',
): Promise<void> {
    if (!options.validationError && options.paths.length === 0) {
        return;
    }

    const errorTitle =
        placement === 'before'
            ? 'Error splitting file(s) into new change before'
            : 'Error splitting file(s) into new change after';

    try {
        if (options.validationError) {
            throw new Error(options.validationError);
        }

        const normalizedInputPaths: string[] = [];
        for (const p of options.paths) {
            normalizedInputPaths.push(await normalizeWorkspaceFilePath(ctx, p));
        }

        const matches = await ctx.repo.jj.getLog({ revision: options.revision, limit: 2, omitChanges: true });
        if (matches.length === 0) {
            throw new Error(`No revision found for: ${options.revision}`);
        }
        if (matches.length > 1) {
            throw new Error(
                `Revision expression "${options.revision}" matched multiple revisions; specify a single revision.`,
            );
        }

        let entry = matches[0];
        if (entry.is_immutable) {
            throw new Error('Cannot split files from an immutable commit.');
        }

        const isWorkingCopy = Boolean(entry.is_current_working_copy) || options.revision === '@';
        const revisionAliases = new Set([options.revision, entry.change_id, entry.commit_id]);
        if (isWorkingCopy) {
            revisionAliases.add('@');
        }

        const flushedInitialJjEdit = await flushDirtySplitDocuments(ctx, {
            targetPaths: normalizedInputPaths,
            isWorkingCopy,
            revisionAliases,
        });
        if (flushedInitialJjEdit && !isWorkingCopy) {
            const refreshed = await ctx.repo.jj.getLog({ revision: entry.change_id, limit: 2, omitChanges: true });
            if (refreshed.length === 1) {
                entry = refreshed[0];
                revisionAliases.add(entry.commit_id);
            }
        }

        let targetRevision = isWorkingCopy ? '@' : entry.commit_id;

        const changes = await ctx.repo.jj.getChanges(targetRevision);
        const platform = ctx.repo.jj.system.platform;
        const changesByPath = new Map<string, JjStatusEntry>();
        for (const change of changes) {
            changesByPath.set(normalizeRepoSeparators(pathNormalize(change.path, platform), platform), change);
        }

        const inputPathSet = new Set(normalizedInputPaths);
        const extraPaths: string[] = [];
        const targetPathSet = new Set<string>();
        for (const relPath of normalizedInputPaths) {
            targetPathSet.add(relPath);
            const change = changesByPath.get(relPath);
            // Extract renames atomically so the old path deletion is not stranded in the original commit.
            if (change?.status === 'renamed' && change.oldPath) {
                const oldRelPath = normalizeRepoSeparators(pathNormalize(change.oldPath, platform), platform);
                targetPathSet.add(oldRelPath);
                if (!inputPathSet.has(oldRelPath)) {
                    extraPaths.push(oldRelPath);
                }
            }
        }

        if (extraPaths.length > 0) {
            const flushedExtraJjEdit = await flushDirtySplitDocuments(ctx, {
                targetPaths: extraPaths,
                isWorkingCopy,
                revisionAliases,
            });
            if (flushedExtraJjEdit && !isWorkingCopy) {
                const refreshed = await ctx.repo.jj.getLog({ revision: entry.change_id, limit: 2, omitChanges: true });
                if (refreshed.length === 1) {
                    entry = refreshed[0];
                    targetRevision = entry.commit_id;
                }
            }
        }

        const targetPaths = Array.from(targetPathSet);

        const progressTitle =
            placement === 'before'
                ? 'Splitting file(s) into new change before...'
                : 'Splitting file(s) into new change after...';

        await ctx.host.ui.withProgress(progressTitle, () =>
            ctx.repo.jj.splitFiles({
                revision: targetRevision,
                paths: targetPaths,
                placement,
            }),
        );

        await ctx.repo.refresh({
            reason: options.revision === '@' ? 'after split' : `after split:${options.revision}`,
        });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, errorTitle, ctx.repo.jj, ctx.log);
    }
}

/**
 * Extracts selected file(s) from a mutable change into a new parent change inserted before it.
 */
export async function splitFilesBeforeCommand(ctx: CommandContext, payload?: SplitFilesPayload): Promise<void> {
    const paths = payload?.paths ?? [];
    if (!payload?.validationError && paths.length === 0) {
        return;
    }
    const revision = payload?.revision?.trim() || '@';
    await splitFiles(ctx, { revision, paths, validationError: payload?.validationError }, 'before');
}

/**
 * Extracts selected file(s) from a mutable change into a new child change inserted after it.
 */
export async function splitFilesAfterCommand(ctx: CommandContext, payload?: SplitFilesPayload): Promise<void> {
    const paths = payload?.paths ?? [];
    if (!payload?.validationError && paths.length === 0) {
        return;
    }
    const revision = payload?.revision?.trim() || '@';
    await splitFiles(ctx, { revision, paths, validationError: payload?.validationError }, 'after');
}
