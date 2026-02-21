/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
 * Determines the maximum length of the shortest unique change ID prefix in the given list of commits.
 * Returns 8 as a fallback if no shortest IDs are available.
 */
export function computeMaxShortestIdLength(commits: ShortestIdCommit[]): number {
    let max = 0;
    for (const commit of commits) {
        if (commit.change_id_shortest) {
            max = Math.max(max, commit.change_id_shortest.length);
        }
    }
    return max > 0 ? max : 8;
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
