/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'pathe';
import type { CommandContext } from '../host/command-context';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import { formatRootFileFileset } from '../jj-service';
import type { Uri } from '../uri-utils';
import { RevisionQuery, resolveWorkspaceRelativePath } from './command-utils';

export { formatRootFileFileset, resolveWorkspaceRelativePath };

export interface RestoreFileFromRevisionPayload {
    fileUri?: Uri;
    revision?: string;
}

export async function restoreFileFromRevisionCommand(
    ctx: CommandContext,
    payload?: RestoreFileFromRevisionPayload,
): Promise<void> {
    try {
        const fileUri = payload?.fileUri;

        if (!fileUri || fileUri.scheme !== 'file' || !fileUri.fsPath) {
            await showJjError(
                ctx.host.ui,
                new Error('No workspace file selected to restore.'),
                'Restore File Error',
                ctx.repo.jj,
                ctx.log,
            );
            return;
        }

        const relPath = await resolveWorkspaceRelativePath(
            ctx.repo.jj.workspaceRoot,
            fileUri.fsPath,
            ctx.host.system?.fs,
        );
        if (relPath === undefined) {
            await showJjError(
                ctx.host.ui,
                new Error('Selected file is outside the repository workspace.'),
                'Restore File Error',
                ctx.repo.jj,
                ctx.log,
            );
            return;
        }

        let isDirectory = relPath === '' || relPath === '.';
        if (!isDirectory && ctx.host.system?.fs) {
            try {
                const resolvedFsPath = path.join(ctx.repo.jj.workspaceRoot, relPath);
                const stat = await ctx.host.system.fs.stat(resolvedFsPath);
                isDirectory = stat.isDirectory();
            } catch {
                // Path does not exist on disk yet (e.g. restoring a deleted file); proceed.
            }
        }

        if (isDirectory) {
            await showJjError(
                ctx.host.ui,
                new Error('Cannot restore a directory. Please select a workspace file.'),
                'Restore File Error',
                ctx.repo.jj,
                ctx.log,
            );
            return;
        }

        const fileName = path.basename(fileUri.fsPath);
        let revision = payload?.revision?.trim() || undefined;
        if (!revision) {
            revision = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
                placeHolder: `Select a revision to restore ${fileName} from`,
                emptyPrompt: `Restore ${fileName} from revision`,
                revisionQuery: RevisionQuery.visible(),
                repoRoot: ctx.repo.rootUri,
                nav: ctx.host.nav,
            });
        }

        const targetRevision = revision?.trim();
        if (!targetRevision) {
            return;
        }

        const matches = await ctx.repo.jj.getLog({ revision: targetRevision, limit: 2, omitChanges: true });
        if (matches.length === 0) {
            throw new Error(`No revision found for: ${targetRevision}`);
        }
        if (matches.length > 1) {
            throw new Error(
                `Revision expression "${targetRevision}" matched multiple revisions; specify a single revision.`,
            );
        }
        const resolvedCommitId = matches[0].commit_id;

        await ctx.host.ui.withProgress(`Restoring ${fileName} from ${targetRevision}...`, async () => {
            await ctx.host.documents.saveIfDirty(fileUri);
            await ctx.repo.jj.restore([formatRootFileFileset(relPath)], { from: resolvedCommitId });
        });
        await ctx.repo.refresh({ reason: 'restoreFileFrom' });
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Failed to restore file from revision', ctx.repo.jj, ctx.log);
    }
}
