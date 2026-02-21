/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjStatusEntry } from './jj-types';

export function createDiffUris(
    entry: JjStatusEntry,
    revision: string,
    root: string,
    options: { editable?: boolean; workingCopyChangeId?: string } = {},
): { leftUri: vscode.Uri; rightUri: vscode.Uri; resourceUri: vscode.Uri } {
    const isWorkingCopy = revision === '@' || revision === options.workingCopyChangeId;
    const resourceUri = isWorkingCopy
        ? vscode.Uri.joinPath(vscode.Uri.file(root), entry.path)
        : vscode.Uri.joinPath(vscode.Uri.file(root), entry.path).with({ query: `jj-revision=${revision}` });

    // For renames/copies, the left side shows the old path
    let leftPath = resourceUri.path;
    if ((entry.status === 'renamed' || entry.status === 'copied') && entry.oldPath) {
        leftPath = vscode.Uri.joinPath(vscode.Uri.file(root), entry.oldPath).path;
    }

    const leftUri = vscode.Uri.from({
        scheme: 'jj-view',
        path: leftPath,
        query: `base=${revision}&side=left&path=${encodeURIComponent(leftPath)}`,
    });

    let rightUri: vscode.Uri;
    if (isWorkingCopy) {
        rightUri = resourceUri;
    } else if (options.editable) {
        // Editable: use jj-edit scheme backed by FileSystemProvider
        rightUri = vscode.Uri.from({
            scheme: 'jj-edit',
            path: resourceUri.path,
            query: `revision=${revision}`,
        });
    } else {
        rightUri = vscode.Uri.from({
            scheme: 'jj-view',
            path: resourceUri.path,
            query: `base=${revision}&side=right`,
        });
    }

    return { leftUri, rightUri, resourceUri };
}

