/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import {
    extractRevision,
    isCurrentWorkingCopyResourceGroup,
    promptForRevision,
    RevisionQuery,
    showJjError,
    withDelayedProgress,
} from './command-utils';

export async function abandonCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]): Promise<void> {
    let revisions: string[] = [];

    // 1. Check if triggered from Working Copy header (ignore selection)
    if (args.some((arg) => isCurrentWorkingCopyResourceGroup(arg))) {
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
        } else if (selectedRevisions.length > 0) {
            revisions = selectedRevisions;
        } else {
            const input = await promptForRevision(jj, {
                placeHolder: 'Select revision to abandon',
                emptyPrompt: 'Enter revision to abandon',
                revisionQuery: RevisionQuery.mutable(),
            });
            if (input) {
                revisions = [input];
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
        await showJjError(e, 'Failed to abandon', jj, scmProvider.outputChannel);
    }
}
