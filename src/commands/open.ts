/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { JjResourceState } from '../scm-resource-state';

// Opens the file on disk (usually the working copy version).
// Strips the query parameter to ensure VS Code opens the local file path.
export async function openFileCommand(resourceState: vscode.SourceControlResourceState | undefined) {
    if (!resourceState) {
        return;
    }
    const uri = resourceState.resourceUri.with({ query: '' });
    await vscode.commands.executeCommand('vscode.open', uri);
}

// Opens the diff view for the given resource state.
// Uses the pre-calculated left and right URIs stored on the JjResourceState.
export async function openChangesCommand(resourceState: JjResourceState | undefined) {
    if (!resourceState?.leftUri || !resourceState?.rightUri) {
        return;
    }
    await vscode.commands.executeCommand(
        'vscode.diff',
        resourceState.leftUri,
        resourceState.rightUri,
        resourceState.diffTitle ?? 'Diff',
    );
}
