/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { showJjError } from './command-utils';

export interface MergeCommandArg {
    revision: string;
}

export async function newMergeChangeCommand(
    scmProvider: JjScmProvider,
    jj: JjService,
    ...args: (MergeCommandArg | undefined)[]
) {
    const revisions: string[] = [];
    for (const arg of args) {
        if (arg?.revision) {
            revisions.push(arg.revision);
        }
    }

    if (revisions.length === 0) {
        // Try getting from selection
        const selection = scmProvider.getSelectedCommitIds();
        if (selection.length > 0) {
            revisions.push(...selection);
        } else {
            // Try getting from context or input
            const rev1 = await vscode.window.showInputBox({ prompt: 'Enter first revision for merge (optional)' });
            if (rev1) {
                revisions.push(rev1);
            }
            const rev2 = await vscode.window.showInputBox({ prompt: 'Enter second revision for merge (optional)' });
            if (rev2) {
                revisions.push(rev2);
            }
        }
    }

    if (revisions.length < 1) {
        vscode.window.showWarningMessage('Need at least 1 revision to create a change.');
        return;
    }

    try {
        await jj.new({ parents: revisions });
        await scmProvider.refresh();
    } catch (e: unknown) {
        showJjError(e, 'Failed to create merge', scmProvider.outputChannel);
    }
}
