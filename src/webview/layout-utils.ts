/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getChangeIdDisplayLength } from '../utils/jj-utils';

/**
 * Calculates the gap between the commit graph and the text content based on font size.
 * Currently set to 0.5 * fontSize.
 */
export function computeGap(fontSize: number): number {
    return Math.round(fontSize * 0.5);
}

/**
 * Interface for minimal commit structure needed for ID length calculation.
 */
export interface ShortestIdCommit {
    change_id_shortest?: string;
}

/**
 * Determines the maximum length of the shortest unique change ID prefix in the given list of commits,
 * but at least minLen.
 */
export function computeMaxShortestIdLength(commits: ShortestIdCommit[], minLen: number): number {
    return commits.reduce((max, commit) => Math.max(max, getChangeIdDisplayLength(commit.change_id_shortest, minLen)), minLen);
}

/**
 * Calculates the total width of the graph area (including margin and gap).
 */
export function computeGraphAreaWidth(
    graphWidth: number,
    laneWidth: number,
    leftMargin: number,
    gap: number,
): number {
    return graphWidth * laneWidth + leftMargin + gap;
}
