/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
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
        revision = await ctx.ui.promptForRevision({
            placeHolder: 'Select target revision to advance bookmarks to',
            revisionQuery: RevisionQuery.ancestorsIncluding('@'),
        });
    }

    if (!revision) {
        return undefined;
    }

    try {
        await ctx.ui.withProgress(`Advancing bookmarks to ${revision.substring(0, 8)}...`, () =>
            ctx.repo.jj.advanceBookmark(revision),
        );
        await ctx.repo.refresh({ reason: 'after bookmark advance' });
        return revision;
    } catch (e: unknown) {
        await ctx.ui.showError(e, 'Error advancing bookmarks');
        throw e;
    }
}
