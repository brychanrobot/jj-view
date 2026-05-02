/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { JjResourceState } from '../jj-scm-provider';

export async function openFileCommand(resourceState: vscode.SourceControlResourceState | undefined) {
    if (!resourceState) {
        return;
    }
    // Open the resourceUri (which is the file in the workspace)
    // Strip query parameters to ensure we open the canonical file
    const uri = resourceState.resourceUri.with({ query: '' });
    await vscode.commands.executeCommand('vscode.open', uri);
}

export async function openChangesCommand(resourceState: JjResourceState | undefined) {
    if (!resourceState?.diffCommand) {
        return;
    }
    const { command, arguments: args } = resourceState.diffCommand;
    await vscode.commands.executeCommand(command, ...(args ?? []));
}
