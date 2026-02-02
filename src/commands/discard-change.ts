/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjScmProvider } from '../jj-scm-provider';
import { getErrorMessage } from './command-utils';

export interface LineChange {
    readonly originalStartLineNumber: number;
    readonly originalEndLineNumber: number;
    readonly modifiedStartLineNumber: number;
    readonly modifiedEndLineNumber: number;
}

export function isLineChangeArray(changes: unknown): changes is LineChange[] {
    if (!Array.isArray(changes)) {
        return false;
    }
    return changes.every((c) => {
        const change = c as LineChange;
        return (
            typeof change.originalStartLineNumber === 'number' &&
            typeof change.originalEndLineNumber === 'number' &&
            typeof change.modifiedStartLineNumber === 'number' &&
            typeof change.modifiedEndLineNumber === 'number'
        );
    });
}

export async function discardChangeCommand(
    scmProvider: JjScmProvider,
    uri: vscode.Uri,
    changes: unknown,
    index: number,
) {
    if (
        !uri ||
        !changes ||
        !isLineChangeArray(changes) ||
        index === undefined ||
        index < 0 ||
        index >= changes.length
    ) {
        return;
    }

    const change = changes[index];

    try {
        const originalUri = scmProvider.provideOriginalResource(uri) as vscode.Uri;
        if (!originalUri) {
            throw new Error('Could not determine original resource');
        }

        const originalDoc = await vscode.workspace.openTextDocument(originalUri);
        const modifiedDoc = await vscode.workspace.openTextDocument(uri);

        // Calculate Original Range
        let originalTextStr = '';
        if (change.originalEndLineNumber >= change.originalStartLineNumber) {
            const startLine = change.originalStartLineNumber - 1;
            const endLine = change.originalEndLineNumber - 1;

            const startPos = new vscode.Position(startLine, 0);
            const endLineObj = originalDoc.lineAt(endLine);
            const endPos = endLineObj.rangeIncludingLineBreak.end;

            originalTextStr = originalDoc.getText(new vscode.Range(startPos, endPos));
        }

        // Calculate Modified Range
        let modifiedRange: vscode.Range;
        if (change.modifiedEndLineNumber >= change.modifiedStartLineNumber) {
            const startLine = change.modifiedStartLineNumber - 1;
            const endLine = change.modifiedEndLineNumber - 1;

            const startPos = new vscode.Position(startLine, 0);
            const endLineObj = modifiedDoc.lineAt(endLine);
            const endPos = endLineObj.rangeIncludingLineBreak.end;

            modifiedRange = new vscode.Range(startPos, endPos);
        } else {
            const insertLine = change.modifiedStartLineNumber - 1;
            modifiedRange = new vscode.Range(insertLine, 0, insertLine, 0);
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.replace(uri, modifiedRange, originalTextStr);
        await vscode.workspace.applyEdit(workspaceEdit);
        await modifiedDoc.save();
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to discard change: ${getErrorMessage(e)}`);
    }
}
