/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { extractRevision, showJjError, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function newBeforeCommand(
    scmProvider: JjScmProvider,
    jj: JjService,
    args: unknown[],
) {
    let targetRevision: string | undefined;

    // Check for arguments (context menu, etc)
    if (args && args.length > 0) {
        targetRevision = extractRevision(args);
    }

    // Fallback: Check for selection in webview
    const revisions: string[] = [];
    if (targetRevision) {
        revisions.push(targetRevision);
    } else {
        const selectedIds = scmProvider.getSelectedCommitIds();
        if (selectedIds.length > 0) {
            revisions.push(...selectedIds);
        } else {
             // Fallback: Default to working copy parent (which is essentially "insert before working copy")
             revisions.push('@');
        }
    }

    if (revisions.length === 0) {
        vscode.window.showErrorMessage('No commit selected to create a new change before.');
        return;
    }

    try {
        await withDelayedProgress(
            'Creating new change...',
            jj.new({ insertBefore: revisions })
        );
        scmProvider.refresh();
    } catch (e: unknown) {
        showJjError(e, `Error creating new commit before ${revisions.join(', ')}`, scmProvider.outputChannel);
    }
}
