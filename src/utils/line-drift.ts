/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HostPlatform } from '../core/host/host-system';
import { normalizeRepoSeparators, unquoteGitPath } from '../core/path-utils';

export interface DiffHunkRange {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
}

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses unified diff hunk headers (`@@ -oldStart,oldCount +newStart,newCount @@`)
 * for a single file.
 */
export function parseDiffHunks(diffOutput: string): DiffHunkRange[] {
    const hunks: DiffHunkRange[] = [];
    for (const line of diffOutput.split(/\r?\n/)) {
        const match = line.match(HUNK_HEADER_REGEX);
        if (!match) {
            continue;
        }
        const oldStart = Number.parseInt(match[1], 10);
        const oldCount = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
        const newStart = Number.parseInt(match[3], 10);
        const newCount = match[4] !== undefined ? Number.parseInt(match[4], 10) : 1;
        hunks.push({ oldStart, oldCount, newStart, newCount });
    }
    return hunks;
}

/**
 * Parses a multi-file unified diff (`git diff -U0`) into a map from normalized
 * repo-relative file path to its ordered list of hunk ranges.
 */
export function parseMultiFileDiffHunks(
    diffOutput: string,
    platform?: HostPlatform | string,
): Map<string, DiffHunkRange[]> {
    const result = new Map<string, DiffHunkRange[]>();
    let currentFile: string | undefined;

    for (const line of diffOutput.split(/\r?\n/)) {
        if (line.startsWith('diff --git ')) {
            currentFile = undefined;
            continue;
        }
        if (line.startsWith('+++ ')) {
            const rawTarget = unquoteGitPath(line.slice(4).trim());
            if (rawTarget === '/dev/null') {
                currentFile = undefined;
            } else {
                const stripped = rawTarget.startsWith('b/') ? rawTarget.slice(2) : rawTarget;
                currentFile = normalizeRepoSeparators(stripped, platform);
                if (!result.has(currentFile)) {
                    result.set(currentFile, []);
                }
            }
            continue;
        }
        if (!currentFile) {
            continue;
        }
        const match = line.match(HUNK_HEADER_REGEX);
        if (!match) {
            continue;
        }
        const oldStart = Number.parseInt(match[1], 10);
        const oldCount = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
        const newStart = Number.parseInt(match[3], 10);
        const newCount = match[4] !== undefined ? Number.parseInt(match[4], 10) : 1;
        result.get(currentFile)?.push({ oldStart, oldCount, newStart, newCount });
    }

    return result;
}

/**
 * Maps a 1-based line number from the "old" revision of a file across a sorted
 * list of unified diff hunks (`git diff -U0`) to the corresponding 1-based line
 * number in the "new" revision.
 */
export function mapLineAcrossHunks(line: number, hunks: readonly DiffHunkRange[]): number {
    if (line <= 0 || hunks.length === 0) {
        return line;
    }

    let delta = 0;
    for (const hunk of hunks) {
        if (hunk.oldCount === 0) {
            // Pure insertion occurs after hunk.oldStart (or before line 1 when oldStart === 0).
            if (line <= hunk.oldStart) {
                return Math.max(1, line + delta);
            }
            delta += hunk.newCount;
            continue;
        }

        // Hunk covers old lines [hunk.oldStart, hunk.oldStart + hunk.oldCount - 1]
        if (line < hunk.oldStart) {
            return Math.max(1, line + delta);
        }

        const oldEndExclusive = hunk.oldStart + hunk.oldCount;
        if (line < oldEndExclusive) {
            if (hunk.newCount === 0) {
                return Math.max(1, hunk.newStart);
            }
            const offsetInHunk = Math.min(line - hunk.oldStart, hunk.newCount - 1);
            return Math.max(1, hunk.newStart + offsetInHunk);
        }

        delta += hunk.newCount - hunk.oldCount;
    }

    return Math.max(1, line + delta);
}
