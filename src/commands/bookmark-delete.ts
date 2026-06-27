/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { extractBookmarkName, getErrorMessage, withDelayedProgress } from './command-utils';

export async function deleteBookmarkCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    let bookmarkName = extractBookmarkName(args);

    // If not triggered via right click, prompt user to select a bookmark
    if (!bookmarkName) {
        try {
            const bookmarks = await withDelayedProgress('Fetching bookmarks...', jj.getBookmarks());
            const quickPick = vscode.window.createQuickPick();
            try {
                quickPick.placeholder = 'Select a bookmark to delete';
                quickPick.items = bookmarks
                    .filter((b) => !b.remote) // Only allow deleting local bookmarks
                    .map((b) => ({ label: b.name, description: 'Delete bookmark' }));

                if (quickPick.items.length === 0) {
                    vscode.window.showInformationMessage('No local bookmarks to delete.');
                    return;
                }

                bookmarkName = await new Promise<string>((resolve) => {
                    quickPick.onDidAccept(() => {
                        const selection = quickPick.selectedItems[0];
                        resolve(selection ? selection.label : '');
                    });
                    quickPick.onDidHide(() => {
                        resolve('');
                    });
                    quickPick.show();
                });
            } finally {
                quickPick.dispose();
            }
        } catch (e) {
            const message = getErrorMessage(e);
            vscode.window.showErrorMessage(`Failed to fetch bookmarks: ${message}`);
            scmProvider.outputChannel.error(`[Error] Fetch bookmarks failed: ${message}`);
            return;
        }
    }

    if (!bookmarkName) {
        return; // User cancelled
    }

    // Perform deletion
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Deleting bookmark "${bookmarkName}"...`,
                cancellable: false,
            },
            async () => {
                await jj.deleteBookmark(bookmarkName);
            },
        );
        scmProvider.refresh({ reason: 'after bookmark delete' });
    } catch (e) {
        const message = getErrorMessage(e);
        vscode.window.showErrorMessage(`Failed to delete bookmark: ${message}`);
        scmProvider.outputChannel.error(`[Error] Bookmark delete failed: ${message}`);
    }
}
