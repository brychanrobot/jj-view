/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { showJjError, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function setBookmarkCommand(
    scmProvider: JjScmProvider,
    jj: JjService,
    context: { changeId?: string; commitId?: string },
) {
    const revision = context?.changeId || context?.commitId;
    if (!revision) {
        return;
    }

    try {
        const bookmarks = await withDelayedProgress('Fetching bookmarks...', jj.getBookmarks());

        // Show QuickPick to allow selecting an existing bookmark or creating a new one
        const quickPick = vscode.window.createQuickPick();
        quickPick.placeholder = 'Select a bookmark to move, or type a new name to create';
        quickPick.items = bookmarks.map((b) => ({ label: b, description: 'Move bookmark' }));
        quickPick.matchOnDescription = true;

        quickPick.onDidAccept(async () => {
            const selection = quickPick.selectedItems[0];
            const name = selection ? selection.label : quickPick.value;

            if (name) {
                quickPick.hide();
                try {
                    await withDelayedProgress(`Setting bookmark ${name}...`, jj.moveBookmark(name, revision));
                    await scmProvider.refresh({ reason: 'after bookmark set' });
                } catch (e: unknown) {
                    await showJjError(e, 'Error setting bookmark', jj, scmProvider.outputChannel);
                }
            }
        });

        quickPick.show();
    } catch (e: unknown) {
        await showJjError(e, 'Error checking bookmarks', jj, scmProvider.outputChannel);
    }
}
