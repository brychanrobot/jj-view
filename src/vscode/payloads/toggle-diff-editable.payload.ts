/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import { extractFileUri } from '../../core/commands/command-utils';
import type { ToggleDiffEditablePayload } from '../../core/commands/toggle-diff-editable';
import { Uri } from '../../core/uri-utils';
import { getActiveDocumentUriFromWindow } from './payload-helpers';

function toCoreUri(uri: Pick<Uri, 'scheme' | 'authority' | 'path' | 'query' | 'fragment'>): Uri {
    return Uri.from({
        scheme: uri.scheme,
        authority: uri.authority,
        path: uri.path,
        query: uri.query,
        fragment: uri.fragment,
    });
}

export function createToggleDiffEditablePayload(args: unknown[]): ToggleDiffEditablePayload {
    const rawExplicit = extractFileUri(args);
    const explicitUri = rawExplicit ? toCoreUri(rawExplicit) : undefined;
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (
        activeTab &&
        'TabInputTextDiff' in vscode &&
        typeof vscode.TabInputTextDiff === 'function' &&
        activeTab.input instanceof vscode.TabInputTextDiff
    ) {
        const leftUri = toCoreUri(activeTab.input.original);
        const rightUri = toCoreUri(activeTab.input.modified);
        const activeOrExplicit =
            explicitUri ??
            (vscode.window.activeTextEditor?.document.uri
                ? toCoreUri(vscode.window.activeTextEditor.document.uri)
                : undefined);
        const activeStr = activeOrExplicit?.toString();
        if (!activeStr || activeStr === rightUri.toString()) {
            return {
                leftUri,
                rightUri,
                resourceUri: explicitUri ?? rightUri,
                title: activeTab.label,
            };
        }
    }

    const fallback = vscode.window.activeTextEditor?.document.uri ?? getActiveDocumentUriFromWindow();
    const resourceUri = explicitUri ?? (fallback ? toCoreUri(fallback) : undefined);
    return { resourceUri };
}
