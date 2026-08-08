/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { JjScmProvider } from '../jj-scm-provider';
import { Uri } from '../uri-utils';
import { showJjError } from './command-utils';

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

export async function discardChangeCommand(scmProvider: JjScmProvider, uri: Uri, changes: unknown, index: number) {
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
        const originalUri = await scmProvider.provideOriginalResource(uri);
        if (!originalUri || !Uri.isUri(originalUri)) {
            throw new Error('Could not determine original resource');
        }

        const originalDoc = await vscode.workspace.openTextDocument(originalUri);
        const modifiedDoc = await vscode.workspace.openTextDocument(uri);

        const getSafeRange = (
            doc: vscode.TextDocument,
            startLine1Based: number,
            endLine1Based: number,
        ): vscode.Range => {
            const lineCount = doc.lineCount;
            if (lineCount === 0) {
                return new vscode.Range(0, 0, 0, 0);
            }
            const startLine = Math.max(0, Math.min(startLine1Based - 1, lineCount - 1));
            const endLine = Math.max(0, Math.min(endLine1Based - 1, lineCount - 1));

            const startPos = new vscode.Position(startLine, 0);
            const endLineObj = doc.lineAt(endLine);
            const endPos = endLineObj.rangeIncludingLineBreak.end;

            return new vscode.Range(startPos, endPos);
        };

        // Calculate Original Range
        let originalTextStr = '';
        if (change.originalEndLineNumber >= change.originalStartLineNumber) {
            originalTextStr = originalDoc.getText(
                getSafeRange(originalDoc, change.originalStartLineNumber, change.originalEndLineNumber),
            );
        }

        // Calculate Modified Range
        let modifiedRange: vscode.Range;
        if (change.modifiedEndLineNumber >= change.modifiedStartLineNumber) {
            modifiedRange = getSafeRange(modifiedDoc, change.modifiedStartLineNumber, change.modifiedEndLineNumber);
        } else {
            const insertLine = Math.max(0, Math.min(change.modifiedStartLineNumber, modifiedDoc.lineCount));
            modifiedRange = new vscode.Range(insertLine, 0, insertLine, 0);
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.replace(uri, modifiedRange, originalTextStr);
        await vscode.workspace.applyEdit(workspaceEdit);
        await modifiedDoc.save();
    } catch (e: unknown) {
        await showJjError(e, 'Failed to discard change', scmProvider.jj, scmProvider.outputChannel);
    }
}
