/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { showJjError, withDelayedProgress } from './command-utils';

export async function commitCommand(scmProvider: JjScmProvider, jj: JjService) {
    const message = scmProvider.sourceControl.inputBox.value;
    if (!message) {
        vscode.window.showWarningMessage('Please provide a commit message');
        return;
    }

    try {
        await withDelayedProgress('Committing...', jj.commit(message));
        scmProvider.sourceControl.inputBox.value = '';
        vscode.window.showInformationMessage('Committed change');
        await scmProvider.refresh({ reason: 'after commit' });
    } catch (err: unknown) {
        showJjError(err, 'Error committing change', scmProvider.outputChannel);
    }
}
