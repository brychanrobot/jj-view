/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { extractRevision, isWorkingCopyResourceGroup, showJjError, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function abandonCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    let revisions: string[] = [];

    // 1. Check if triggered from Working Copy header (ignore selection)
    if (args.some(isWorkingCopyResourceGroup)) {
        revisions = ['@'];
    } else {
        // 2. Check explicit argument (e.g. context menu click)
        const clickedRevision = extractRevision(args);

        // 3. Check selection
        const selectedRevisions = scmProvider.getSelectedCommitIds();

        if (clickedRevision) {
            if (selectedRevisions.includes(clickedRevision)) {
                // Clicked on a selection -> abandon all selected
                revisions = selectedRevisions;
            } else {
                // Clicked outside selection -> abandon only the clicked one
                revisions = [clickedRevision];
            }
        } else {
            // No click arg -> use selection or prompt
            if (selectedRevisions.length > 0) {
                revisions = selectedRevisions;
            } else {
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter revision to abandon',
                    placeHolder: 'Revision ID (e.g. @, commit_id)',
                });
                if (input) {
                    revisions = [input];
                }
            }
        }
    }

    if (revisions.length === 0) {
        return;
    }

    try {
        await withDelayedProgress('Abandoning...', jj.abandon(revisions));
        await scmProvider.refresh();
        vscode.window.showInformationMessage(`Abandoned ${revisions.length} change(s).`);
    } catch (e: unknown) {
        // const errorMessage = e instanceof Error ? e.message : String(e);
        showJjError(e, 'Error abandoning commit', scmProvider.outputChannel);
    }
}
