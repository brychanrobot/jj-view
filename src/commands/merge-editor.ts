/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjScmProvider } from '../jj-scm-provider';
import { getErrorMessage, collectResourceStates } from './command-utils';

export async function openMergeEditorCommand(scmProvider: JjScmProvider, arg: unknown, ...rest: unknown[]) {
    // Handle both: direct object { resourceUri } from command.arguments OR array from menu context
    const resourceStates = collectResourceStates([arg, ...rest]);

    if (resourceStates.length === 0) {
        console.warn('jj-view.openMergeEditor: No valid resource states provided');
        return;
    }

    try {
        await scmProvider.openMergeEditor(resourceStates);
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Error opening merge editor: ${getErrorMessage(e)}`);
    }
}
