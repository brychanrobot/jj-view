/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { extractFileUri, extractRevision, isLineChangeArray, type LineChange } from '../../core/commands/command-utils';
import type { Uri } from '../../core/uri-utils';

export interface FileAndRevisionPayload {
    fileUri?: Uri;
    revision?: string;
}

export type { LineChange };
export { isLineChangeArray };

/**
 * Extracts the document/modified URI represented by a VS Code tab input.
 */
export function getUriFromTab(tab: vscode.Tab): Uri | undefined {
    const { input } = tab;
    if ('TabInputText' in vscode && typeof vscode.TabInputText === 'function' && input instanceof vscode.TabInputText) {
        return input.uri;
    }
    if (
        'TabInputCustom' in vscode &&
        typeof vscode.TabInputCustom === 'function' &&
        input instanceof vscode.TabInputCustom
    ) {
        return input.uri;
    }
    if (
        'TabInputNotebook' in vscode &&
        typeof vscode.TabInputNotebook === 'function' &&
        input instanceof vscode.TabInputNotebook
    ) {
        return input.uri;
    }
    if (
        'TabInputTextDiff' in vscode &&
        typeof vscode.TabInputTextDiff === 'function' &&
        input instanceof vscode.TabInputTextDiff
    ) {
        return input.modified;
    }
    if (
        'TabInputNotebookDiff' in vscode &&
        typeof vscode.TabInputNotebookDiff === 'function' &&
        input instanceof vscode.TabInputNotebookDiff
    ) {
        return input.modified;
    }
    return undefined;
}

/**
 * Resolves the active window document URI, checking the active tab before falling back to activeTextEditor.
 */
export function getActiveDocumentUriFromWindow(): Uri | undefined {
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (activeTab) {
        const tabUri = getUriFromTab(activeTab);
        if (tabUri) {
            return tabUri;
        }
    }
    return vscode.window.activeTextEditor?.document.uri;
}

/**
 * Extracts a file URI (falling back to the active tab or text editor document) and an optional revision.
 */
export function extractFileUriAndRevision(args: unknown[]): FileAndRevisionPayload {
    const fileUri = extractFileUri(args) ?? getActiveDocumentUriFromWindow();
    const revision = extractRevision(args);
    return { fileUri, revision };
}

/**
 * Extracts an active resource URI (falling back to the active tab or text editor document).
 */
export function extractActiveResourceUri(args: unknown[]): { resourceUri?: Uri } {
    const resourceUri = extractFileUri(args) ?? getActiveDocumentUriFromWindow();
    return { resourceUri };
}
