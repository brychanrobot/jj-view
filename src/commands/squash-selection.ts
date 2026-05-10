/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { showJjError } from './command-utils';

interface LineChange {
    readonly originalStartLineNumber: number;
    readonly originalEndLineNumber: number;
    readonly modifiedStartLineNumber: number;
    readonly modifiedEndLineNumber: number;
}

function isLineChangeArray(changes: unknown): changes is LineChange[] {
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

/**
 * Command to squash a specific change (hunk) from the editor gutter into its parent.
 */
export async function squashHunkIntoParentCommand(
    scmProvider: JjScmProvider,
    jj: JjService,
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
    const isDeletion = change.modifiedEndLineNumber < change.modifiedStartLineNumber;

    let startLine: number;
    let endLine: number;

    if (isDeletion) {
        startLine = change.modifiedStartLineNumber - 1;
        endLine = change.modifiedStartLineNumber;
    } else {
        startLine = change.modifiedStartLineNumber - 1;
        endLine = change.modifiedEndLineNumber - 1;
    }

    const ranges = [{ startLine, endLine }];
    const relPath = path.relative(jj.workspaceRoot, uri.fsPath);

    const originalUri = scmProvider.provideOriginalResource(uri);
    let revision = '@';
    if (originalUri && originalUri instanceof vscode.Uri && originalUri.query) {
        const queryParams = new URLSearchParams(originalUri.query);
        revision = queryParams.get('base') || '@';
    }

    try {
        await jj.squashSelectionIntoParent(relPath, ranges, revision);
        vscode.window.showInformationMessage('Squashed hunk into parent.');

        await scmProvider.refresh({ reason: 'after squash hunk into parent' });
        // Force Quick Diff refresh
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.toString() === uri.toString()) {
            const viewColumn = activeEditor.viewColumn;
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await vscode.window.showTextDocument(uri, { viewColumn, preview: false });
        }
    } catch (e: unknown) {
        await showJjError(e, 'Failed to squash hunk', jj, scmProvider.outputChannel);
    }
}

/**
 * Command to squash selected lines from a diff editor into their parent.
 */
export async function squashSelectionIntoParentCommand(
    scmProvider: JjScmProvider,
    jj: JjService,
    editor: vscode.TextEditor,
) {
    if (!editor) {
        return;
    }

    const docUri = editor.document.uri;
    const fsPath = docUri.fsPath;
    const relPath = path.relative(jj.workspaceRoot, fsPath);

    const query = new URLSearchParams(docUri.query);
    const revision = query.get('jj-revision') || '@';

    const ranges = editor.selections.map((s) => ({ startLine: s.start.line, endLine: s.end.line }));

    try {
        await jj.squashSelectionIntoParent(relPath, ranges, revision);
        vscode.window.showInformationMessage(`Squashed selection from ${revision} into parent.`);
    } catch (e: unknown) {
        await showJjError(e, 'Failed to squash selection', jj, scmProvider.outputChannel);
    } finally {
        await scmProvider.refresh({ reason: 'after squash selection into parent' });
    }
}
