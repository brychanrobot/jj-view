/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import { RevisionQuery } from './command-utils';

export interface AdvanceBookmarkPayload {
    revision?: string;
}

export async function advanceBookmarkCommand(
    ctx: CommandContext,
    payload?: AdvanceBookmarkPayload,
): Promise<string | undefined> {
    let revision = payload?.revision;

    if (!revision) {
        revision = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
            placeHolder: 'Select target revision to advance bookmarks to',
            revisionQuery: RevisionQuery.mutableAncestorsIncluding('@'),
        });
    }

    if (!revision) {
        return undefined;
    }

    try {
        await ctx.host.ui.withProgress(`Advancing bookmarks to ${revision.substring(0, 8)}...`, () =>
            ctx.repo.jj.advanceBookmark(revision),
        );
        await ctx.repo.refresh({ reason: 'after bookmark advance' });
        return revision;
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error advancing bookmarks', ctx.repo.jj, ctx.log);
        throw e;
    }
}
