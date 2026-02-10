/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { showJjError, withDelayedProgress } from './command-utils';

export async function describePromptCommand(scmProvider: JjScmProvider, jj: JjService) {
    // Determine the default value for the prompt
    const inputBoxValue = scmProvider.sourceControl.inputBox.value;
    const defaultValue = inputBoxValue || (await jj.getDescription('@'));

    // Always show the prompt, pre-filled with either the input box value or current description
    const input = await vscode.window.showInputBox({
        prompt: 'Set description',
        placeHolder: 'Description of the changes...',
        value: defaultValue,
    });

    if (input === undefined) {
        // User cancelled
        return;
    }

    const description = input;

    try {
        await withDelayedProgress('Setting description...', jj.describe(description));
        await scmProvider.refresh({ reason: 'after describe' });
    } catch (err: unknown) {
        showJjError(err, 'Error setting description', scmProvider.outputChannel);
    }
}
