/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { getErrorMessage, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function setBookmarkCommand(scmProvider: JjScmProvider, jj: JjService, context: { commitId: string }) {
    if (!context || !context.commitId) {
        return;
    }
    const commitId = context.commitId;

    try {
        const bookmarks = await withDelayedProgress('Fetching bookmarks...', jj.getBookmarks());
        
        // Show QuickPick to allow selecting an existing bookmark or creating a new one
        const quickPick = vscode.window.createQuickPick();
        quickPick.placeholder = 'Select a bookmark to move, or type a new name to create';
        quickPick.items = bookmarks.map(b => ({ label: b, description: 'Move bookmark' }));
        quickPick.matchOnDescription = true;
        
        quickPick.onDidAccept(async () => {
            const selection = quickPick.selectedItems[0];
            const name = selection ? selection.label : quickPick.value;
            
            if (name) {
                quickPick.hide();
                try {
                    await withDelayedProgress(`Setting bookmark ${name}...`, jj.moveBookmark(name, commitId));
                    await scmProvider.refresh({ reason: 'after bookmark set' });
                } catch (e: unknown) {
                    vscode.window.showErrorMessage(`Error setting bookmark: ${getErrorMessage(e)}`);
                }
            }
        });
        
        quickPick.show();

    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Error checking bookmarks: ${getErrorMessage(e)}`);
    }
}
