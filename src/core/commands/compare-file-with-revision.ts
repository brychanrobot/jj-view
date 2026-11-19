/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import { pathBasename } from '../path-utils';
import { createRevisionUri, type Uri } from '../uri-utils';
import { RevisionQuery } from './command-utils';

export interface CompareFileWithRevisionPayload {
    fileUri?: Uri;
    revision?: string;
}

export async function compareFileWithRevisionCommand(
    ctx: CommandContext,
    payload?: CompareFileWithRevisionPayload,
): Promise<void> {
    try {
        const fileUri = payload?.fileUri;

        if (!fileUri || fileUri.scheme !== 'file') {
            await showJjError(
                ctx.host.ui,
                new Error('No workspace file selected for comparison.'),
                'Compare File Error',
                ctx.repo.jj,
                ctx.log,
            );
            return;
        }

        const platform = ctx.repo.jj.system.platform;
        const fileName = pathBasename(fileUri.fsPath, platform);
        let revision = payload?.revision;
        if (!revision) {
            revision = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
                placeHolder: `Select an ancestor to compare ${fileName} with`,
                emptyPrompt: `Compare ${fileName} with revision`,
                revisionQuery: RevisionQuery.ancestorsExcluding('@'),
                repoRoot: ctx.repo.rootUri,
                nav: ctx.host.nav,
            });
        }

        if (!revision) {
            return;
        }

        const { jj } = ctx.repo;
        const leftUri = createRevisionUri(jj.workspaceRoot, fileUri.fsPath, revision, platform);

        const title = `${fileName} (${revision} ↔ Working Copy)`;
        await ctx.host.nav.openDiff(leftUri, fileUri, title);
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Failed to compare file', ctx.repo.jj, ctx.log);
    }
}
