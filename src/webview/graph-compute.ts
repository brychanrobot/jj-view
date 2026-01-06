// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

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

    return { nodes, edges, width, height: sortedRows.length, rows: sortedRows };
}
