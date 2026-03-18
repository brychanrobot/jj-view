/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GraphLayout, GraphNode, GraphEdge } from './graph-model';
import { JjLogEntry } from '../jj-types';

function getColor(lane: number): string {
    return `var(--jj-lane-${lane % 7})`;
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
            isImmutable: commit.is_immutable,
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
                // Parent was assigned a higher lane by a sibling branch.
                // Move it to the child's (now-free) lane so converging branches
                // collapse to the leftmost lane, matching `jj log` behavior.
                lanes[p0Lane] = null;
                lanes[nodeLane] = p0;
                p0Lane = nodeLane;
            } else {
                // p0 already occupies a lower lane, so nodeLane is now free.
                // Allow secondary parents to inherit it (e.g. merge's second
                // parent continues straight down through the node's lane).
                allocated.delete(nodeLane);
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
        let targetX: number;
        let targetY: number;

        let isJoining = false;
        if (target) {
            targetY = target.y;
            // Cross-lane edges (pe.x1 !== pe.targetLane) are "joining" an existing
            // vertical line in pe.targetLane. They should merge into that lane, not
            // chase the target if it later moved to a different lane.
            // Same-lane edges (pe.x1 === pe.targetLane) "own" the lane and follow
            // the target to its final position (e.g. when a later sibling rebalances
            // the parent leftward).
            targetX = pe.x1 !== pe.targetLane ? pe.targetLane : target.x;

            // For joining edges where the target moved lanes (targetX !== target.x),
            // cap y2 at the curveY of the "owning" edge — the edge that travels
            // vertically through pe.targetLane and then curves to target.x.
            // This prevents the joining edge from drawing a vertical line past
            // where the lane actually curves away.
            if (targetX !== target.x) {
                const ownerEdge = edges.find((e) => e.x1 === pe.targetLane && e.x2 === target.x && e.y2 === target.y);

                if (ownerEdge) {
                    targetY = ownerEdge.curveY ?? ownerEdge.y2;
                    isJoining = true;
                }
            }
        } else {
            targetX = pe.targetLane;
            targetY = sortedRows.length;
        }

        let curveY = targetY;
        if (pe.x1 !== targetX) {
            // For joining edges, also check the target lane for blocking nodes.
            // Owning edges only check their source lane — they travel vertically
            // through the source lane and curve at the end.
            const checkTargetLane = pe.x1 !== pe.targetLane;
            for (let y = pe.y1 + 1; y < targetY; y++) {
                if (nodes[y] && (nodes[y].x === pe.x1 || (checkTargetLane && nodes[y].x === targetX))) {
                    curveY = y;
                    break;
                }
            }
        }

        edges.push({
            x1: pe.x1,
            y1: pe.y1,
            x2: targetX,
            y2: targetY,
            curveY,
            color: pe.color,
            type: 'parent',
            isJoining,
        });
    });

    const width = Math.max(
        lanes.length,
        nodes.reduce((max, n) => Math.max(max, n.x + 1), 0),
    );

    return { nodes, edges, width, height: sortedRows.length, rows: sortedRows };
}
