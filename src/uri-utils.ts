/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { match } from 'ts-pattern';
import * as vscode from 'vscode';
import type { JjStatusEntry } from './jj-types';

export type JjViewQuery =
    | { mode: 'diff'; base: string; side: 'left' | 'right' }
    | { mode: 'revision'; revision: string };

export function encodeJjViewQuery(query: JjViewQuery): string {
    const params = new URLSearchParams();
    match(query)
        .with({ mode: 'diff' }, (q) => {
            params.set('base', q.base);
            params.set('side', q.side);
        })
        .with({ mode: 'revision' }, (q) => {
            params.set('revision', q.revision);
        })
        .exhaustive();
    return params.toString();
}

export function decodeJjViewQuery(queryStr: string): JjViewQuery {
    const params = new URLSearchParams(queryStr);
    const revision = params.get('revision');
    const base = params.get('base');
    const side = params.get('side');

    if (revision) {
        return { mode: 'revision', revision };
    }
    if (base && side) {
        if (side !== 'left' && side !== 'right') {
            throw new Error(`Invalid side in jj-view query: ${side}`);
        }
        return { mode: 'diff', base, side: side as 'left' | 'right' };
    }
    throw new Error(`Invalid query combination for jj-view: ${queryStr}`);
}

export function createDiffUris(
    entry: JjStatusEntry,
    revision: string,
    root: string,
    options: { editable?: boolean; workingCopyChangeId?: string } = {},
): { leftUri: vscode.Uri; rightUri: vscode.Uri; resourceUri: vscode.Uri } {
    const isCurrentWorkingCopy = revision === '@' || revision === options.workingCopyChangeId;
    const resourceUri = isCurrentWorkingCopy
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
        query: encodeJjViewQuery({ mode: 'diff', base: revision, side: 'left' }),
    });

    let rightUri: vscode.Uri;
    const isDeleted = entry.status === 'removed' || entry.status === 'deleted';
    if (isDeleted) {
        rightUri = vscode.Uri.from({
            scheme: 'jj-view',
            path: resourceUri.path,
            query: encodeJjViewQuery({ mode: 'diff', base: revision, side: 'right' }),
        });
    } else if (isCurrentWorkingCopy) {
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
            query: encodeJjViewQuery({ mode: 'diff', base: revision, side: 'right' }),
        });
    }

    return { leftUri, rightUri, resourceUri };
}

/**
 * Extract a revision ID from a URI query.
 * Handles jj-revision (SCM resource), revision (jj-edit), and base (jj-view diff).
 */
export function getRevisionFromUri(uri: vscode.Uri): string | undefined {
    const query = new URLSearchParams(uri.query);
    return query.get('jj-revision') || query.get('revision') || query.get('base') || undefined;
}
