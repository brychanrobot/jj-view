/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { getChangeIdDisplayLength } from '../utils/jj-utils';
import { GraphLayout } from './graph-model';

/**
 * Calculates the maximum lane index occupied by any graph element (node or edge) in each row.
 * This is used for 'compact' label alignment to push text securely to the right of all lanes.
 *
 * The rule is: No text is ever drawn to the left of an edge passing through its row center.
 * Crucially, horizontal curves exist in the space *between* rows. Therefore, an edge is
 * completely at `x1` above its curve row, and completely at `x2` at/below its curve row.
 */
export function computeCompactRowMaxX(layout: GraphLayout): number[] {
    const rowMaxX = new Array(layout.rows.length).fill(0);

    for (const { x, y } of layout.nodes) {
        if (y >= 0 && y < rowMaxX.length) rowMaxX[y] = Math.max(rowMaxX[y], x);
    }

    for (const e of layout.edges) {
        const cY = e.curveY ?? e.y2;
        for (let y = Math.max(0, e.y1); y <= e.y2 && y < rowMaxX.length; y++) {
            // If the row center is above the curve, it is at x1.
            // If the row center is at or below the curve, it has already curved to x2.
            rowMaxX[y] = Math.max(rowMaxX[y], y < cY ? e.x1 : e.x2);
        }
    }

    return rowMaxX;
}

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
    return commits.reduce(
        (max, commit) => Math.max(max, getChangeIdDisplayLength(commit.change_id_shortest, minLen)),
        minLen,
    );
}

/**
 * Calculates the total width of the graph area (including margin and gap).
 */
export function computeGraphAreaWidth(graphWidth: number, laneWidth: number, leftMargin: number, gap: number): number {
    return graphWidth * laneWidth + leftMargin + gap;
}
