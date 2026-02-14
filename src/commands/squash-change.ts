/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { getErrorMessage } from './command-utils';

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

export async function squashChangeCommand(
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

    // Convert LineChange to SelectionRange (0-indexed for JJ service)
    // VS Code LineChange uses 1-indexed line numbers
    //
    // For deletions: modifiedEndLineNumber < modifiedStartLineNumber (empty range in modified)
    // For additions: originalEndLineNumber < originalStartLineNumber (empty range in original)
    // For changes: both ranges have content
    //
    // The patch helper works on "new" (modified) line numbers, so we need to handle deletions specially.
    // For a deletion, modifiedStartLineNumber indicates where the gap is in the modified file.
    // modifiedEndLineNumber is 0 (or < modifiedStartLineNumber) for pure deletions.

    const isDeletion = change.modifiedEndLineNumber < change.modifiedStartLineNumber;

    let startLine: number;
    let endLine: number;

    if (isDeletion) {
        // For deletions, modifiedStartLineNumber points to the position AFTER which the deletion occurs.
        // The patch helper processes hunks with hunkNewLineIndex advancing through context lines.
        // To select the deletion block, we need a range that covers where hunkNewLineIndex will be
        // when the deletion block is processed.
        startLine = change.modifiedStartLineNumber - 1;
        endLine = change.modifiedStartLineNumber; // Extend one past to catch the deletion position
    } else {
        // For additions and changes, use the modified line numbers
        startLine = change.modifiedStartLineNumber - 1;
        endLine = change.modifiedEndLineNumber - 1;
    }

    const ranges = [{ startLine, endLine }];

    const relPath = path.relative(jj.workspaceRoot, uri.fsPath);

    // Get current diff and validate that the change exists in JJ's view
    let diffOutput = '';
    try {
        diffOutput = await jj.getDiff('@', relPath);
    } catch {
        // If we can't get the diff, continue anyway - the move operation will fail with a clear error
    }

    // Check if there's actually a diff from JJ's perspective
    if (!diffOutput || diffOutput.trim() === '') {
        vscode.window.showWarningMessage(
            'This change is not visible to JJ. It may be a whitespace or newline difference.',
        );
        return;
    }

    // Parse the diff to check if our range falls within any hunk
    // This catches cases where VS Code sees a change (e.g., EOF newline) that JJ doesn't track separately
    const hunkRegex = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g;
    let rangeInHunk = false;
    let match;
    while ((match = hunkRegex.exec(diffOutput)) !== null) {
        const hunkNewStart = parseInt(match[1], 10);
        const hunkNewLen = match[2] ? parseInt(match[2], 10) : 1;
        const hunkNewEnd = hunkNewStart + hunkNewLen - 1;
        // Check if our range (1-indexed) overlaps with the hunk
        const rangeStart1 = startLine + 1;
        const rangeEnd1 = endLine + 1;
        if (rangeStart1 <= hunkNewEnd && rangeEnd1 >= hunkNewStart) {
            rangeInHunk = true;
            break;
        }
    }

    if (!rangeInHunk) {
        vscode.window.showWarningMessage(
            'This change cannot be squashed separately. It may be a newline or whitespace change at the end of the file.',
        );
        return;
    }

    try {
        await jj.movePartialToParent(relPath, ranges);
        vscode.window.showInformationMessage('Squashed change to parent.');

        // Only refresh on success
        await scmProvider.refresh();
        // Force Quick Diff refresh by closing and reopening the editor
        // This is the only reliable way to force VS Code to recompute quick diff decorations
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.toString() === uri.toString()) {
            const viewColumn = activeEditor.viewColumn;
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await vscode.window.showTextDocument(uri, { viewColumn, preview: false });
        }
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to squash change: ${getErrorMessage(e)}`);
    }
}
