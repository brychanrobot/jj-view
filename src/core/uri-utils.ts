/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { match } from 'ts-pattern';
import { URI, Utils } from 'vscode-uri';
import type { JjStatusEntry } from './jj-types';

export type Uri = URI;
export const Uri = Object.assign(URI, {
    joinPath: Utils.joinPath,
});

export type JjViewQuery =
    | { mode: 'diff'; root?: string; base: string; side: 'left' | 'right' }
    | { mode: 'revision'; root?: string; revision: string };

export function encodeJjViewQuery(query: JjViewQuery): string {
    const params = new URLSearchParams();
    if (query.root) {
        params.set('root', query.root);
    }
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

function stripPrefix(str: string | undefined): string {
    return (str || '').replace(/^[#?]/, '');
}

/**
 * Helper to parse URL parameters from a URI, checking fragment first with query fallback.
 */
export function getUriParams(uri: Uri): URLSearchParams {
    const fragmentStr = stripPrefix(uri.fragment);
    const queryStr = stripPrefix(uri.query);
    const combinedStr = fragmentStr && queryStr ? `${fragmentStr}&${queryStr}` : fragmentStr || queryStr;
    return new URLSearchParams(combinedStr);
}

export function decodeJjViewQuery(uri: Uri): JjViewQuery {
    const params = getUriParams(uri);
    const root = params.get('root') || params.get('repoRoot') || undefined;
    const revision = params.get('revision');
    const base = params.get('base');
    const side = params.get('side');

    if (revision) {
        return { mode: 'revision', root, revision };
    }
    if (base && side) {
        if (side !== 'left' && side !== 'right') {
            throw new Error(`Invalid side in jj-view query: ${side}`);
        }
        return { mode: 'diff', root, base, side: side as 'left' | 'right' };
    }
    throw new Error(`Invalid query combination for jj-view: ${uri.toString()}`);
}

/**
 * Normalizes backslashes in a file path to forward slashes.
 */
export function toForwardSlash(p: string): string {
    return p.replace(/\\/g, '/');
}

function normalizePath(p: string): string {
    const norm = path.normalize(toForwardSlash(p));
    const isWinDrive = /^[a-zA-Z]:/.test(norm);
    return process.platform === 'win32' || isWinDrive ? norm.toLowerCase() : norm;
}

export function getFsPathFromUri(uri: Uri): string {
    const params = getUriParams(uri);
    const targetPath = params.get('path');
    if (targetPath) {
        return path.normalize(targetPath);
    }
    const root = params.get('root') || params.get('repoRoot');
    if (root) {
        const normPath = path.normalize(uri.fsPath);
        if (normalizePath(uri.fsPath).startsWith(normalizePath(root))) {
            return normPath;
        }
        const decodedPath = decodeURIComponent(uri.path);
        const relativePath = decodedPath.startsWith('/') ? decodedPath.substring(1) : decodedPath;
        return path.resolve(root, relativePath);
    }
    return uri.fsPath;
}

export function createDiffUris(
    entry: JjStatusEntry,
    revision: string,
    root: string,
    options: { editable?: boolean; workingCopyChangeId?: string } = {},
): { leftUri: Uri; rightUri: Uri; resourceUri: Uri } {
    const isCurrentWorkingCopy = revision === '@' || revision === options.workingCopyChangeId;
    const relPath = entry.path.startsWith('/') ? entry.path : `/${entry.path}`;

    // For renames/copies, the left side shows the old path
    let leftRelPath = relPath;
    if ((entry.status === 'renamed' || entry.status === 'copied') && entry.oldPath) {
        leftRelPath = entry.oldPath.startsWith('/') ? entry.oldPath : `/${entry.oldPath}`;
    }

    const leftUri = Uri.from({
        scheme: 'jj-view',
        path: leftRelPath,
        fragment: encodeJjViewQuery({ mode: 'diff', root, base: revision, side: 'left' }),
    });

    const resourceParams = new URLSearchParams();
    resourceParams.set('root', root);
    resourceParams.set('jj-revision', revision);
    resourceParams.set('revision', isCurrentWorkingCopy ? '@' : revision);

    const resourceUri = Uri.from({
        scheme: options.editable || isCurrentWorkingCopy ? 'jj-edit' : 'jj-view',
        path: relPath,
        fragment: resourceParams.toString(),
    });

    let rightUri: Uri;
    const isDeleted = entry.status === 'deleted';
    if (isDeleted) {
        rightUri = Uri.from({
            scheme: 'jj-view',
            path: relPath,
            fragment: encodeJjViewQuery({ mode: 'diff', root, base: revision, side: 'right' }),
        });
    } else if (isCurrentWorkingCopy || options.editable) {
        rightUri = resourceUri;
    } else {
        rightUri = Uri.from({
            scheme: 'jj-view',
            path: relPath,
            fragment: encodeJjViewQuery({ mode: 'diff', root, base: revision, side: 'right' }),
        });
    }

    return { leftUri, rightUri, resourceUri };
}

/**
 * Extract a revision ID from a URI query or fragment.
 * Handles jj-revision (SCM resource), revision (jj-edit), and base (jj-view diff).
 */
export function getRevisionFromUri(uri: Uri): string | undefined {
    const params = getUriParams(uri);
    return params.get('jj-revision') || params.get('revision') || params.get('base') || undefined;
}

/**
 * Checks if a URI uses a Jujutsu-specific scheme.
 */
export function isJjScheme(uri: Uri): boolean {
    return uri.scheme === 'jj-view' || uri.scheme === 'jj-edit';
}

/**
 * Creates a jj-view URI for viewing a file at a specific revision.
 */
export function createRevisionUri(root: string, filePath: string, revision: string): Uri {
    const normRoot = toForwardSlash(root);
    const normFile = toForwardSlash(filePath);
    let relativePath = filePath;

    if (normFile.toLowerCase().startsWith(normRoot.toLowerCase())) {
        relativePath = normFile.substring(normRoot.length);
    } else if (path.isAbsolute(filePath)) {
        relativePath = path.relative(root, filePath);
    }

    const posixRel = toForwardSlash(relativePath);
    const relPathStr = posixRel.startsWith('/') ? posixRel : `/${posixRel}`;
    return Uri.from({
        scheme: 'jj-view',
        path: relPathStr,
        fragment: encodeJjViewQuery({ mode: 'revision', root, revision }),
    });
}

/**
 * Gets the original resource URI (left side / base) for a file in the workspace or revision.
 */
export function getOriginalResourceUri(root: string, uri: Uri): Uri {
    const revision = getRevisionFromUri(uri) || '@';
    const relativePath = getRepoRelativePath(uri, root);
    const relPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
    return Uri.from({
        scheme: 'jj-view',
        path: relPath,
        fragment: encodeJjViewQuery({ mode: 'diff', root, base: revision, side: 'left' }),
    });
}

/**
 * Converts a URI (which may be a custom scheme or contain fragment parameters)
 * into a standard file scheme URI pointing to the underlying workspace file.
 */
export function toFileUri(uri: Uri): Uri {
    return Uri.file(getFsPathFromUri(uri));
}

/**
 * Gets the relative path of a URI within the repository root.
 * Normalizes leading slash.
 */
export function getRepoRelativePath(uri: Uri, root: string): string {
    if (uri.scheme === 'file') {
        let canonicalRoot = root;
        let canonicalPath = uri.fsPath;
        try {
            canonicalRoot = fs.realpathSync(root);
        } catch {}
        try {
            canonicalPath = fs.realpathSync(uri.fsPath);
        } catch {}
        const rel = toForwardSlash(path.relative(canonicalRoot, canonicalPath));
        return rel.startsWith('/') ? rel : `/${rel}`;
    }
    return uri.path.startsWith('/') ? uri.path : `/${uri.path}`;
}

/**
 * Creates a custom editor URI for a commit details view.
 */
export function createCommitDetailsUri(params: { repoRoot: string; changeId: string; title: string }): Uri {
    const fragmentParams = new URLSearchParams();
    fragmentParams.set('changeId', params.changeId);
    fragmentParams.set('repoRoot', params.repoRoot);

    return Uri.from({
        scheme: 'jj-commit',
        authority: 'commit',
        path: `/${params.title}`,
        fragment: fragmentParams.toString(),
    });
}

/**
 * Extracts commit details document information from a custom editor URI.
 */
export function parseCommitDetailsUri(uri: Uri): { changeId: string; repoRoot?: Uri } {
    const params = getUriParams(uri);
    const changeId = params.get('changeId') || '';
    const repoRootPath = params.get('repoRoot');
    const repoRoot = repoRootPath ? Uri.file(repoRootPath) : undefined;
    return { changeId, repoRoot };
}
