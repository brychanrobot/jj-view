/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { promptSelectOrCreate, showJjError } from '../host/ui-helpers';

export interface SetBookmarkPayload {
    revision?: string;
    name?: string;
}

export async function setBookmarkCommand(ctx: CommandContext, payload?: SetBookmarkPayload): Promise<void> {
    const revision = payload?.revision;
    if (!revision) {
        return;
    }

    try {
        let name = payload?.name?.trim() || undefined;
        if (!name) {
            const bookmarks = await ctx.host.ui.withProgress('Fetching bookmarks...', () => ctx.repo.jj.getBookmarks());

            name = await promptSelectOrCreate(ctx.host.ui, {
                placeHolder: 'Select a bookmark to move, or type a new name to create',
                items: bookmarks.filter((b) => !b.remote).map((b) => ({ label: b.name, description: 'Move bookmark' })),
            });

            if (!name) {
                return;
            }
        }

        await ctx.host.ui.withProgress(`Setting bookmark ${name}...`, () => ctx.repo.jj.moveBookmark(name, revision));
        await ctx.repo.refresh({ reason: 'after bookmark set' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error setting bookmark', ctx.repo.jj, ctx.log);
    }
}
