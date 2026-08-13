/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';

export interface DeleteBookmarkPayload {
    bookmarkName?: string;
}

export async function deleteBookmarkCommand(ctx: CommandContext, payload?: DeleteBookmarkPayload): Promise<void> {
    let bookmarkName = payload?.bookmarkName?.trim() || undefined;

    if (!bookmarkName) {
        try {
            const bookmarks = await ctx.ui.withProgress('Fetching bookmarks...', () => ctx.repo.jj.getBookmarks());
            const items = bookmarks.filter((b) => !b.remote).map((b) => ({ label: b.name, value: b.name }));

            if (items.length === 0) {
                await ctx.ui.showInformation('No local bookmarks to delete.');
                return;
            }

            const pick = await ctx.ui.showQuickPick(items, { placeHolder: 'Select a bookmark to delete' });
            bookmarkName = pick?.value as string | undefined;
        } catch (e: unknown) {
            await ctx.ui.showError(e, 'Failed to fetch bookmarks');
            return;
        }
    }

    if (!bookmarkName) {
        return;
    }

    try {
        await ctx.ui.withProgress(`Deleting bookmark "${bookmarkName}"...`, () =>
            ctx.repo.jj.deleteBookmark(bookmarkName),
        );
        await ctx.repo.refresh({ reason: 'after bookmark delete' });
        await ctx.ui.showInformation(`Deleted bookmark "${bookmarkName}".`);
    } catch (e: unknown) {
        await ctx.ui.showError(e, 'Failed to delete bookmark');
    }
}
