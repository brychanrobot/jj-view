/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { JjLogEntry } from '../jj-types';
import { GraphEdge, GraphLayout, GraphNode } from './graph-model';
import { getColor } from './themes.generated';

export function computeGraphLayout(commits: JjLogEntry[], themeName: string = 'default'): GraphLayout {
    // 1. Build Unique Nodes and Edges
    // The input 'commits' array is already sorted by 'jj log' (graph order).
    // We trust this order implicitly.
    const allCommits = new Map<string, JjLogEntry>();
    commits.forEach((c) => allCommits.set(c.change_id, c));

    // Layout Logic
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const pendingEdges: {
        x1: number;
        y1: number;
        targetChangeId: string;
        targetLane: number;
        color: string;
        isElided?: boolean;
    }[] = [];
    const lanes: (string | null)[] = [];
    const nodeMap = new Map<string, GraphNode>();

    commits.forEach((commit, rowIndex) => {
        const changeId = commit.change_id;

        // 1. Determine my lane
        let nodeLane = lanes.indexOf(changeId);
        if (nodeLane === -1) {
            nodeLane = lanes.indexOf(null);
            if (nodeLane === -1) {
                nodeLane = lanes.length;
            }
        }

        // 2. Create Node
        const nodeColor = getColor(nodeLane, themeName);
        const node: GraphNode = {
            commitId: commit.commit_id,
            changeId,
            x: nodeLane,
            y: rowIndex,
            color: nodeColor,
            isCurrentWorkingCopy: !!commit.is_current_working_copy,
            workingCopies: commit.working_copies,
            conflict: commit.conflict,
            isEmpty: commit.is_empty,
            isImmutable: commit.is_immutable,
        };
        nodes.push(node);
        nodeMap.set(changeId, node);

        // 3. Update Lanes (Clear self and overlapping)
        lanes[nodeLane] = null;
        for (let i = 0; i < lanes.length; i++) {
            if (lanes[i] === changeId) {
                lanes[i] = null;
            }
        }

        // 4. Handle Parents (Assign Lanes & Create Edges)
        // We exclusively use nearest_visible_ancestors (change IDs).
        const ancestors = commit.nearest_visible_ancestors || [];
        const directParents = new Set(commit.parent_change_ids || []);
        const allocated = new Set<number>();
        allocated.add(nodeLane);

        if (ancestors.length > 0) {
            const p0 = ancestors[0];
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
                // Allow secondary parents to inherit it.
                allocated.delete(nodeLane);
            }
            pendingEdges.push({
                x1: nodeLane,
                y1: rowIndex,
                targetChangeId: p0,
                targetLane: p0Lane,
                color: nodeColor,
                isElided: !directParents.has(p0),
            });
        }

        for (let i = 1; i < ancestors.length; i++) {
            const p = ancestors[i];
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
                targetChangeId: p,
                targetLane: pLane,
                color: getColor(pLane, themeName),
                isElided: !directParents.has(p),
            });
        }

        // 4b. No visible ancestors for non-root: create trailing elided edge
        if (ancestors.length === 0 && directParents.size > 0) {
            pendingEdges.push({
                x1: nodeLane,
                y1: rowIndex,
                targetChangeId: 'unresolved-elision', // Dummy ID for trailing edge
                targetLane: nodeLane,
                color: nodeColor,
                isElided: true,
            });
        }
    });

    // 5. Resolve Edges
    pendingEdges.forEach((pe) => {
        const target = nodeMap.get(pe.targetChangeId);
        let targetX: number;
        let targetY: number;
        let isJoining: boolean = false;

        if (target) {
            targetY = target.y;
            // Cross-lane edges (pe.x1 !== pe.targetLane) are "joining" an existing
            // vertical line in pe.targetLane. They should merge into that lane, not
            // chase the target if it later moved to a different lane.
            // Same-lane edges (pe.x1 === pe.targetLane) "own" the lane and follow
            // the target to its final position.
            targetX = pe.x1 !== pe.targetLane ? pe.targetLane : target.x;

            // For joining edges where the target moved lanes (targetX !== target.x),
            // cap y2 at the curveY of the "owning" edge.
            if (targetX !== target.x) {
                const ownerEdge = edges.find((e) => e.x1 === pe.targetLane && e.x2 === target.x && e.y2 === target.y);

                if (ownerEdge) {
                    targetY = ownerEdge.curveY ?? ownerEdge.y2;
                    isJoining = true;
                }
            }
        } else {
            targetX = pe.targetLane;
            targetY = commits.length;
        }

        let curveY = targetY;
        if (pe.x1 !== targetX) {
            // For joining edges, also check the target lane for blocking nodes.
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
            isElided: pe.isElided || target === undefined,
        });
    });

    const width = Math.max(
        lanes.length,
        nodes.reduce((max, n) => Math.max(max, n.x + 1), 0),
    );

    return { nodes, edges, width, height: commits.length, rows: commits };
}
