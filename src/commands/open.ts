/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';

export async function openFileCommand(resourceState: vscode.SourceControlResourceState | undefined) {
    if (!resourceState) {
        return;
    }
    // Open the resourceUri (which is the file in the workspace)
    // Strip query parameters to ensure we open the canonical file
    const uri = resourceState.resourceUri.with({ query: '' });
    await vscode.commands.executeCommand('vscode.open', uri);
}
