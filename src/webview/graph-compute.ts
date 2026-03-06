/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GraphLayout, GraphNode, GraphEdge } from './graph-model';
import { JjLogEntry } from '../jj-types';

const COLORS = [
    '#00aa00', // Green
    '#ffaa00', // Orange
    '#00aaff', // Blue
    '#ff00aa', // Pink
    '#aa00ff', // Purple
    '#00aaaa', // Cyan
    '#aaaa00', // Yellow
];

function getColor(lane: number): string {
    return COLORS[lane % COLORS.length];
}

export function computeGraphLayout(commits: JjLogEntry[]): GraphLayout {
    // 1. Build Unique Nodes and Edges
    // The input 'commits' array is already sorted by 'jj log' (graph order).
    // We trust this order implicitly.
    const allCommits = new Map<string, JjLogEntry>();
    commits.forEach((c) => allCommits.set(c.commit_id, c));

    // Use input order directly.
    // We don't need sorting or ancestry checks because jj has already done it.
    const sortedRows = commits;

    // Layout Logic
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const pendingEdges: { x1: number; y1: number; targetCommitId: string; targetLane: number; color: string }[] = [];
    const lanes: (string | null)[] = [];
    const nodeMap = new Map<string, GraphNode>();

    sortedRows.forEach((commit, rowIndex) => {
        const commitId = commit.commit_id;

        // 1. Determine my lane
        let nodeLane = lanes.indexOf(commitId);
        if (nodeLane === -1) {
            nodeLane = lanes.indexOf(null);
            if (nodeLane === -1) {
                nodeLane = lanes.length;
            }
        }

        // 2. Create Node
        const nodeColor = getColor(nodeLane);
        const node: GraphNode = {
            commitId,
            changeId: commit.change_id,
            x: nodeLane,
            y: rowIndex,
            color: nodeColor,
            isWorkingCopy: !!commit.is_working_copy,
            conflict: commit.conflict,
            isEmpty: commit.is_empty,
        };
        nodes.push(node);
        nodeMap.set(commitId, node);

        // 3. Update Lanes (Clear self and overlapping)
        lanes[nodeLane] = null;
        for (let i = 0; i < lanes.length; i++) {
            if (lanes[i] === commitId) {
                lanes[i] = null;
            }
        }

        // 4. Handle Parents (Assign Lanes & Create Edges)
        const parents = commit.parents || [];
        const allocated = new Set<number>();
        allocated.add(nodeLane);

        if (parents.length > 0) {
            const p0 = parents[0];
            let p0Lane = lanes.indexOf(p0);
            if (p0Lane === -1) {
                p0Lane = nodeLane;
                lanes[nodeLane] = p0;
            } else if (p0Lane > nodeLane) {
                // Parent was reserved at a wider lane by another child.
                // Move it to the current (narrower) lane to match jj's layout:
                // this creates a ├─╯ join connector instead of keeping the
                // parent at the wider lane.
                lanes[p0Lane] = null;
                lanes[nodeLane] = p0;
                p0Lane = nodeLane;
            }
            pendingEdges.push({
                x1: nodeLane,
                y1: rowIndex,
                targetCommitId: p0,
                targetLane: p0Lane,
                color: nodeColor,
            });
        }

        for (let i = 1; i < parents.length; i++) {
            const p = parents[i];
            let pLane = lanes.indexOf(p);

            if (pLane === -1) {
                let free = -1;
                for (let k = 0; k < lanes.length; k++) {
                    if (lanes[k] === null && !allocated.has(k)) {
                        free = k;
                        break;
                    }
                }
                if (free === -1) {
                    let cand = lanes.length;
                    while (allocated.has(cand)) {
                        cand++;
                    }
                    free = cand;
                }
                pLane = free;
                lanes[free] = p;
                allocated.add(free);
            }

            pendingEdges.push({
                x1: nodeLane,
                y1: rowIndex,
                targetCommitId: p,
                targetLane: pLane,
                color: getColor(pLane),
            });
        }
    });

    // 5. Resolve Edges
    pendingEdges.forEach((pe) => {
        const target = nodeMap.get(pe.targetCommitId);
        if (target) {
            edges.push({
                x1: pe.x1,
                y1: pe.y1,
                x2: target.x,
                y2: target.y,
                color: pe.color,
                type: 'parent',
            });
        } else {
            // Parent is off-screen.
            // Draw to the bottom of the graph at the assigned lane.
            edges.push({
                x1: pe.x1,
                y1: pe.y1,
                x2: pe.targetLane,
                y2: sortedRows.length,
                color: pe.color,
                type: 'parent',
            });
        }
    });

    const width = Math.max(
        lanes.length,
        nodes.reduce((max, n) => Math.max(max, n.x + 1), 0),
    );

    // Compute per-row active widths for text alignment.
    // Uses the "bend before target" model:
    // - Straight edges occupy their lane for all rows between source and target
    // - Angled edges stay at source lane until bending just before the target
    const rowWidths: number[] = new Array(sortedRows.length).fill(0);
    for (const node of nodes) {
        rowWidths[node.y] = Math.max(rowWidths[node.y], node.x + 1);
    }
    for (const edge of edges) {
        const minY = Math.min(edge.y1, edge.y2);
        const maxY = Math.max(edge.y1, edge.y2);
        const maxLane = Math.max(edge.x1, edge.x2) + 1;
        if (edge.x1 === edge.x2) {
            // Straight edge: active for all rows
            for (let y = minY; y <= maxY && y < sortedRows.length; y++) {
                rowWidths[y] = Math.max(rowWidths[y], maxLane);
            }
        } else {
            // Angled edge: active at source lane until y2-1
            for (let y = minY; y <= maxY - 1 && y < sortedRows.length; y++) {
                rowWidths[y] = Math.max(rowWidths[y], maxLane);
            }
        }
    }

    return { nodes, edges, width, height: sortedRows.length, rows: sortedRows, rowWidths };
}
