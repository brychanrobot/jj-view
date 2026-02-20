/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { showJjError, withDelayedProgress } from './command-utils';

export interface CommitMenuContext {
    commitId: string;
}

export async function rebaseOntoSelectedCommand(scmProvider: JjScmProvider, jj: JjService, arg: CommitMenuContext) {
    if (!arg || !arg.commitId) {
        return;
    }
    const sourceId = arg.commitId;

    const selectedIds = scmProvider.getSelectedCommitIds();
    if (!selectedIds || selectedIds.length === 0) {
        vscode.window.showErrorMessage('No commits selected to rebase onto.');
        return;
    }

    try {
        await withDelayedProgress('Rebasing...', jj.rebase(sourceId, selectedIds, 'source'));
        vscode.window.showInformationMessage(
            `Rebasing ${sourceId.substring(0, 8)} onto ${selectedIds.length} dest(s).`,
        );
        await vscode.commands.executeCommand('jj-view.refresh');
    } catch (err: unknown) {
        showJjError(err, 'Error rebasing', scmProvider.outputChannel);
    }
}
