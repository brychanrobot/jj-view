/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as vscode from 'vscode';
import { isLineChangeArray } from '../../core/commands/command-utils';
import type {
    SquashHunkIntoParentPayload,
    SquashSelectionIntoParentPayload,
} from '../../core/commands/squash-selection';
import type { Uri } from '../../core/uri-utils';

export function createSquashHunkIntoParentPayload(args: unknown[]): SquashHunkIntoParentPayload {
    const uri = args[0] as Uri | undefined;
    const changes = args[1];
    const index = args[2] as number | undefined;

    if (
        !uri ||
        !changes ||
        !isLineChangeArray(changes) ||
        index === undefined ||
        index < 0 ||
        index >= changes.length
    ) {
        return {};
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

    return { uri, ranges: [{ startLine, endLine }] };
}

export function createSquashSelectionIntoParentPayload(editor?: vscode.TextEditor): SquashSelectionIntoParentPayload {
    if (!editor) {
        return {};
    }
    const uri = editor.document.uri;
    const ranges = editor.selections.map((s) => ({ startLine: s.start.line, endLine: s.end.line }));
    return { uri, ranges };
}
