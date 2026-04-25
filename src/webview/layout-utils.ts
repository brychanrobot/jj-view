/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { getChangeIdDisplayLength } from '../utils/jj-utils';
import type { GraphLayout } from './graph-model';

/**
 * Calculates the maximum lane index occupied by any graph element (node or edge) in each row.
 * This is used for 'compact' label alignment to push text securely to the right of all lanes.
 *
 * The rule is: No text is ever drawn to the left of an edge passing through its row center.
 * Crucially, horizontal curves exist in the space *between* rows. Therefore, an edge is
 * completely at `x1` above its curve row, and completely at `x2` at/below its curve row.
 */
export function computeCompactRowMaxX(layout: GraphLayout): number[] {
    const rowMaxX = new Array(layout.height).fill(0);

    // 1. Account for node positions
    for (const { x, y } of layout.nodes) {
        const rowIndex = Math.floor(y);
        if (rowIndex >= 0 && rowIndex < rowMaxX.length) {
            rowMaxX[rowIndex] = Math.max(rowMaxX[rowIndex], x);
        }
    }

    // 2. Account for edges passing through rows.
    // Instead of iterating over individual points (which might be missing for some rows),
    // we analyze the continuous segments of each edge to determine which lanes are occupied
    // at each integer row center.
    for (const e of layout.edges) {
        if (e.points.length < 2) {
            continue;
        }

        const yCoords = e.points.map((p) => p.y);
        const yMin = Math.floor(Math.min(...yCoords));
        const yMax = Math.ceil(Math.max(...yCoords));

        for (let y = Math.max(0, yMin); y <= yMax && y < rowMaxX.length; y++) {
            for (let i = 0; i < e.points.length - 1; i++) {
                const p1 = e.points[i];
                const p2 = e.points[i + 1];
                const segmentYMin = Math.min(p1.y, p2.y);
                const segmentYMax = Math.max(p1.y, p2.y);

                if (y >= segmentYMin && y <= segmentYMax) {
                    rowMaxX[y] = Math.max(rowMaxX[y], p1.x, p2.x);
                }
            }
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
