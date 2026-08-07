/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { JjResourceState } from '../scm-resource-state';
import { toFileUri } from '../uri-utils';
import { extractFileUri } from './command-utils';

// Opens the file on disk (working copy version).
// Extracts the file URI from command arguments (or active text editor),
// converts the scheme to 'file', and strips query/fragment parameters.
export async function openFileCommand(...args: unknown[]) {
    const resourceUri = extractFileUri(args);
    if (!resourceUri) {
        return;
    }
    const uri = toFileUri(resourceUri);
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
