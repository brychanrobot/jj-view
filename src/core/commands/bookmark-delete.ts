/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export interface DeleteBookmarkPayload {
    bookmarkName?: string;
}

export async function deleteBookmarkCommand(ctx: CommandContext, payload?: DeleteBookmarkPayload): Promise<void> {
    let bookmarkName = payload?.bookmarkName?.trim() || undefined;

    if (!bookmarkName) {
        try {
            const bookmarks = await ctx.host.ui.withProgress('Fetching bookmarks...', () => ctx.repo.jj.getBookmarks());
            const items = bookmarks.filter((b) => !b.remote).map((b) => ({ label: b.name, value: b.name }));

            if (items.length === 0) {
                await ctx.host.ui.showInformation('No local bookmarks to delete.');
                return;
            }

            const pick = await ctx.host.ui.showQuickPick(items, { placeHolder: 'Select a bookmark to delete' });
            bookmarkName = pick?.value as string | undefined;
        } catch (e: unknown) {
            await showJjError(ctx.host.ui, e, 'Failed to fetch bookmarks', ctx.repo.jj, ctx.log);
            return;
        }
    }

    if (!bookmarkName) {
        return;
    }

    try {
        await ctx.host.ui.withProgress(`Deleting bookmark "${bookmarkName}"...`, () =>
            ctx.repo.jj.deleteBookmark(bookmarkName),
        );
        await ctx.repo.refresh({ reason: 'after bookmark delete' });
        await ctx.host.ui.showInformation(`Deleted bookmark "${bookmarkName}".`);
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Failed to delete bookmark', ctx.repo.jj, ctx.log);
    }
}
