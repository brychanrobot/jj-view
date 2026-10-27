/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ScmSnapshot } from '../../../src/core/scm-model';

export interface ScmRepositoryEntry {
    workspaceRoot: string;
    snapshot: ScmSnapshot | undefined;
}

export interface RepositoryDisplayName {
    name: string;
    qualifier?: string;
}

/**
 * Determines whether a repository snapshot represents an empty working copy and nothing else.
 * Returns true if the snapshot is undefined or if:
 * - workingCopyChanges is empty
 * - conflictedPaths is empty
 * - ancestors is empty
 * - description is empty (whitespace trimmed)
 */
export function hasOnlyEmptyWorkingCopy(snapshot: ScmSnapshot | undefined): boolean {
    if (!snapshot) {
        return true;
    }
    if (snapshot.workingCopyChanges.length > 0) {
        return false;
    }
    if (snapshot.conflictedPaths.length > 0) {
        return false;
    }
    if (snapshot.ancestors.length > 0) {
        return false;
    }
    if (snapshot.description.trim().length > 0) {
        return false;
    }
    return true;
}

/**
 * Computes human-readable display names for a list of repository root paths.
 * Uses the directory basename when unique across all repositories, and includes
 * parent directory segments as a qualifier when multiple repositories share a basename.
 */
export function formatRepositoryDisplayNames(roots: readonly string[]): Map<string, RepositoryDisplayName> {
    const result = new Map<string, RepositoryDisplayName>();
    const splitByRoot = new Map<string, string[]>();

    for (const root of roots) {
        const segments = root
            .replace(/[/\\]+$/, '')
            .split(/[/\\]/)
            .filter(Boolean);
        splitByRoot.set(root, segments.length > 0 ? segments : [root]);
    }

    const basenameCount = new Map<string, number>();
    for (const segments of splitByRoot.values()) {
        const base = segments[segments.length - 1] ?? '';
        basenameCount.set(base, (basenameCount.get(base) ?? 0) + 1);
    }

    for (const [root, segments] of splitByRoot.entries()) {
        const base = segments[segments.length - 1] ?? root;
        if ((basenameCount.get(base) ?? 0) <= 1 || segments.length <= 1) {
            result.set(root, { name: base });
            continue;
        }

        let depth = 2;
        while (depth < segments.length) {
            const candidate = segments.slice(-depth).join('/');
            let collides = false;
            for (const [otherRoot, otherSegments] of splitByRoot.entries()) {
                if (otherRoot === root) {
                    continue;
                }
                if (otherSegments.slice(-depth).join('/') === candidate) {
                    collides = true;
                    break;
                }
            }
            if (!collides) {
                break;
            }
            depth++;
        }

        const qualifier = segments.slice(-depth, -1).join('/');
        result.set(root, {
            name: base,
            qualifier: qualifier || undefined,
        });
    }

    return result;
}
