/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { extractRemoteFileUrlPayload, reviveUriLike } from '../../core/commands/command-utils';
import type { RemoteFileUrlPayload } from '../../core/commands/remote-file-url';
import type { Uri } from '../../core/uri-utils';
import { toOneBasedLineRange } from '../../utils/remote-url-utils';
import { getActiveDocumentUriFromWindow } from './payload-helpers';

function getActiveEditorSelectionForUri(uri: Uri) {
    const editor = vscode.window.activeTextEditor;
    if (!editor?.document?.uri) {
        return undefined;
    }
    const editorUri = reviveUriLike(editor.document.uri);
    if (!editorUri || editorUri.toString() !== uri.toString()) {
        return undefined;
    }
    const sel = editor.selection;
    if (!sel) {
        return undefined;
    }
    return toOneBasedLineRange({ startLine: sel.start.line, endLine: sel.end.line });
}

/**
 * Builds a `RemoteFileUrlPayload` from VS Code command arguments across active editors,
 * Explorer context menus, SCM resource items, and Commit Details RPC calls.
 */
export function createRemoteFileUrlPayload(args: unknown[]): RemoteFileUrlPayload {
    const { hasExplicitSource, payload } = extractRemoteFileUrlPayload(args);
    if (hasExplicitSource) {
        if (!payload.fileUri || payload.skipActiveSelection || payload.lineRange) {
            return payload;
        }
        const isExplorerContext = args.length >= 2 && Array.isArray(args[1]);
        if (isExplorerContext) {
            return { ...payload, skipActiveSelection: true };
        }
        return {
            ...payload,
            lineRange: getActiveEditorSelectionForUri(payload.fileUri),
            skipActiveSelection: false,
        };
    }

    // Command Palette / keybinding with no arguments: prefer focused activeTextEditor (handles split diff panes)
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor?.document?.uri) {
        const coreUri = reviveUriLike(activeEditor.document.uri);
        const lineRange = activeEditor.selection
            ? toOneBasedLineRange({
                  startLine: activeEditor.selection.start.line,
                  endLine: activeEditor.selection.end.line,
              })
            : undefined;
        return {
            fileUri: coreUri,
            lineRange,
        };
    }

    const fallbackUri = getActiveDocumentUriFromWindow();
    return {
        fileUri: fallbackUri ? reviveUriLike(fallbackUri) : undefined,
    };
}
