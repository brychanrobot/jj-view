/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { extractRevisions, showJjError, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function newBeforeCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    let revisions: string[] = [];

    // 1. Revisions from arguments (context menu, etc)
    const argRevisions = extractRevisions(args);

    // 2. Selection from provider
    const selectedIds = scmProvider.getSelectedCommitIds();

    if (argRevisions.length > 0) {
        // If the right-clicked commit is part of the selection, use the full selection.
        // This allows "New Before" to apply to multiple selected commits if you right-click one of them.
        const target = argRevisions[0];
        if (selectedIds.includes(target)) {
            revisions = selectedIds;
        } else {
            revisions = argRevisions;
        }
    } else if (selectedIds.length > 0) {
        revisions = selectedIds;
    } else {
        // Fallback: Default to working copy (insert before working copy)
        revisions = ['@'];
    }

    if (revisions.length === 0) {
        vscode.window.showErrorMessage('No commit selected to create a new change before.');
        return;
    }

    try {
        await withDelayedProgress('Creating new change...', jj.new({ insertBefore: revisions }));
        scmProvider.refresh();
    } catch (e: unknown) {
        await showJjError(e, `Error creating new commit before ${revisions.join(', ')}`, jj, scmProvider.outputChannel);
    }
}
