/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { showJjError, withDelayedProgress } from './command-utils';

export async function commitPromptCommand(scmProvider: JjScmProvider, jj: JjService) {
    // Determine the default value for the prompt
    const inputBoxValue = scmProvider.sourceControl.inputBox.value;
    const defaultValue = inputBoxValue || (await jj.getDescription('@'));

    // Always show the prompt, pre-filled with either the input box value or current description
    const input = await vscode.window.showInputBox({
        prompt: 'Commit message',
        placeHolder: 'Description of the change...',
        value: defaultValue,
    });

    if (input === undefined) {
        // User cancelled
        return;
    }

    const message = input;

    try {
        await withDelayedProgress('Committing...', jj.commit(message));
        await scmProvider.refresh({ reason: 'after commit' });
    } catch (err: unknown) {
        showJjError(err, 'Error committing change', scmProvider.outputChannel);
    }
}
