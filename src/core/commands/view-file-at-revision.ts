/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import { pathBasename } from '../path-utils';
import { createRevisionUri, type Uri } from '../uri-utils';
import { RevisionQuery } from './command-utils';

export interface ViewFileAtRevisionPayload {
    fileUri?: Uri;
    revision?: string;
}

export async function viewFileAtRevisionCommand(
    ctx: CommandContext,
    payload?: ViewFileAtRevisionPayload,
): Promise<void> {
    try {
        const fileUri = payload?.fileUri;

        if (!fileUri || fileUri.scheme !== 'file') {
            await showJjError(
                ctx.host.ui,
                new Error('No workspace file selected.'),
                'View File Error',
                ctx.repo.jj,
                ctx.log,
            );
            return;
        }

        const platform = ctx.repo.jj.system.platform;
        let revision = payload?.revision;
        if (!revision) {
            revision = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
                placeHolder: `Select a revision to view ${pathBasename(fileUri.fsPath, platform)} at`,
                revisionQuery: RevisionQuery.visible(),
                repoRoot: ctx.repo.rootUri,
                nav: ctx.host.nav,
            });
        }

        if (!revision) {
            return;
        }

        const { jj } = ctx.repo;
        const revisionUri = createRevisionUri(jj.workspaceRoot, fileUri.fsPath, revision, platform);

        await ctx.host.nav.openFile(revisionUri);
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Failed to view file at revision', ctx.repo.jj, ctx.log);
    }
}
