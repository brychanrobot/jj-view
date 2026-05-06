/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type Ancestor, GraphRowRenderer, NodeLine } from 'renderdag-ts';
import { match } from 'ts-pattern';
import type { JjLogEntry } from '../jj-types';
import type { GraphEdge, GraphLayout, GraphNode, GraphPoint, GraphRow } from './graph-model';
import { isElisionRow } from './graph-model';
import { getColor } from './themes.generated';

function cleanupPoints(points: GraphPoint[]): GraphPoint[] {
    if (points.length <= 2) {
        return points;
    }
    const result: GraphPoint[] = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
        const prev = result[result.length - 1];
        const curr = points[i];
        const next = points[i + 1];

        const isCollinear = (prev.x === curr.x && curr.x === next.x) || (prev.y === curr.y && curr.y === next.y);

        if (!isCollinear) {
            result.push(curr);
        }
    }
    result.push(points[points.length - 1]);
    return result;
}

interface ActiveEdge {
    edge: GraphEdge;
    targetChangeId: string;
    currentLane: number;
    maxLane: number;
}

/**
 * Computes the graph layout using renderdag-ts.
 * We use a single coordinate system where each commit i spans one row with fractional links:
 * - nodeY = i (Node placement row)
 * - linkY = i + 0.5 (Link/Transition row)
 */
export function computeGraphLayout(commits: JjLogEntry[], themeName: string = 'default'): GraphLayout {
    const headLog = commits.find((l) => l.is_current_working_copy);
    const headId = headLog ? headLog.change_id : '';

    const displayRows: GraphRow[] = [];

    commits.forEach((commit) => {
        displayRows.push(commit);

        const parentChangeIds = commit.parents.map((p) => p.change_id);
        const parents = commit.nearest_visible_ancestors || parentChangeIds;
        const directParents = new Set(parentChangeIds);
        parents.forEach((p) => {
            if (!directParents.has(p)) {
                displayRows.push({ type: 'elision', targetId: p });
            }
        });
    });

    const renderer = new GraphRowRenderer<string>();

    const commitToRowIndex = new Map<string, number>();
    displayRows.forEach((row, i) => {
        if (!isElisionRow(row)) {
            commitToRowIndex.set(row.change_id, i);
        }
    });

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const terminations: { x: number; y: number }[] = [];
    let activeEdges: ActiveEdge[] = [];
    let maxColumns = 0;

    displayRows.forEach((row, rowIndex) => {
        const nodeY = rowIndex;
        const linkY = rowIndex + 0.5;

        const { changeId, renderParents, glyph, message, parents, directParents } = match(row)
            .with({ type: 'elision' }, (elision) => ({
                changeId: `elided-${elision.targetId}`,
                renderParents: [{ type: 'Parent', id: elision.targetId }] as Ancestor<string>[],
                glyph: '',
                message: '',
                parents: [elision.targetId],
                directParents: new Set<string>(),
            }))
            .otherwise((commit) => {
                const parentChangeIds = commit.parents.map((p) => p.change_id);
                const parents = commit.nearest_visible_ancestors || parentChangeIds;
                const directParents = new Set(parentChangeIds);
                const renderParents = parents.map((p) => {
                    if (!directParents.has(p)) {
                        return { type: 'Parent', id: `elided-${p}` };
                    }
                    return { type: 'Parent', id: p };
                }) as Ancestor<string>[];

                return {
                    changeId: commit.change_id,
                    renderParents,
                    glyph: commit.change_id === headId ? '@' : '○',
                    message: commit.description || '',
                    parents,
                    directParents,
                };
            });

        const rowData = renderer.nextRow(changeId, renderParents, glyph, message);
        maxColumns = Math.max(maxColumns, renderer.activeColumns ? renderer.activeColumns.length : 0);

        // 1. Determine current node position
        const nodeLane = rowData.nodeLine.indexOf(NodeLine.Node);
        if (nodeLane === -1) {
            return;
        }

        if (isElisionRow(row)) {
            // It's a synthetic elision row! Record its termination marker
            terminations.push({ x: nodeLane, y: nodeY });
        }

        const nodeColor = getColor(nodeLane, themeName);
        if (!isElisionRow(row)) {
            const commit = row as JjLogEntry;
            nodes.push({
                commitId: commit.commit_id,
                changeId: commit.change_id,
                x: nodeLane,
                y: nodeY,
                color: nodeColor,
                isCurrentWorkingCopy: !!commit.is_current_working_copy,
                workingCopies: commit.working_copies,
                conflict: commit.conflict,
                isEmpty: commit.is_empty,
                isImmutable: commit.is_immutable,
                isHidden: commit.is_hidden,
            });
        }

        // 2. Process vertical segments through the node row (nodeY)
        activeEdges.forEach((ae) => {
            ae.edge.points.push({ type: 'node', x: ae.currentLane, y: nodeY });
        }); // 3. Terminate edges that reached this node or continue if it's an elision
        if (isElisionRow(row)) {
            activeEdges.forEach((ae) => {
                if (ae.targetChangeId === changeId) {
                    ae.targetChangeId = row.targetId;
                    ae.edge.isElided = true;
                    if (ae.currentLane !== nodeLane) {
                        ae.edge.points.push({ type: 'node', x: nodeLane, y: nodeY });
                        ae.currentLane = nodeLane;
                    }
                }
            });
        } else {
            activeEdges = activeEdges.filter((ae) => {
                if (ae.targetChangeId === changeId) {
                    if (ae.currentLane !== nodeLane) {
                        ae.edge.points.push({ type: 'node', x: nodeLane, y: nodeY });
                        ae.maxLane = Math.max(ae.maxLane, nodeLane);
                        ae.edge.color = getColor(ae.maxLane, themeName);
                    }
                    edges.push(ae.edge);
                    return false;
                }
                return true;
            });
        }

        // 4. Process horizontal segments and transitions in the link row (linkY)
        const nextActiveColumns = renderer.activeColumns;

        activeEdges.forEach((ae) => {
            const nextLane = nextActiveColumns.findIndex(
                (col) =>
                    (col.type === 'Parent' || col.type === 'Ancestor' || col.type === 'Reserved') &&
                    col.id === ae.targetChangeId,
            );

            if (nextLane !== -1) {
                if (nextLane !== ae.currentLane) {
                    ae.edge.points.push({ type: 'link', x: ae.currentLane, y: linkY });
                    ae.edge.points.push({ type: 'link', x: nextLane, y: linkY });
                    ae.currentLane = nextLane;
                    ae.maxLane = Math.max(ae.maxLane, nextLane);
                    ae.edge.color = getColor(ae.maxLane, themeName);
                } else {
                    ae.edge.points.push({ type: 'link', x: ae.currentLane, y: linkY });
                }
            }
        });

        // 5. Spawn new edges for parents (only for real commits!)
        if (!isElisionRow(row)) {
            const actualParents = parents.map((p) => {
                if (!directParents.has(p)) {
                    return `elided-${p}`;
                }
                return p;
            });

            actualParents.forEach((pId) => {
                const pLane = nextActiveColumns.findIndex(
                    (col) =>
                        (col.type === 'Parent' || col.type === 'Ancestor' || col.type === 'Reserved') && col.id === pId,
                );

                if (pLane !== -1) {
                    const maxLane = Math.max(nodeLane, pLane);
                    const color = getColor(maxLane, themeName);

                    const newEdge: GraphEdge = {
                        id: `${changeId}->${pId}`,
                        type: 'parent',
                        color,
                        isElided: pId.startsWith('elided-'),
                        points: [
                            { type: 'node', x: nodeLane, y: nodeY },
                            { type: 'link', x: nodeLane, y: linkY },
                            { type: 'link', x: pLane, y: linkY },
                        ],
                    };

                    activeEdges.push({
                        edge: newEdge,
                        targetChangeId: pId,
                        currentLane: pLane,
                        maxLane,
                    });
                }
            });
        }

        // 6. Handle elision trailing markers (anonymous roots)
        if (parents.length === 0 && directParents.size > 0) {
            edges.push({
                id: `${changeId}->unresolved-elision`,
                type: 'parent',
                color: nodeColor,
                isElided: true,
                points: [
                    { type: 'node', x: nodeLane, y: nodeY },
                    { type: 'node', x: nodeLane, y: nodeY + 1 },
                ],
            });
            terminations.push({ x: nodeLane, y: nodeY + 1 });
        }
    });

    // Terminate remaining active edges (history continues below)
    activeEdges.forEach((ae) => {
        ae.edge.points.push({ type: 'node', x: ae.currentLane, y: displayRows.length });
        ae.maxLane = Math.max(ae.maxLane, ae.currentLane);
        ae.edge.color = getColor(ae.maxLane, themeName);
        edges.push(ae.edge);
    });

    const cleanedEdges = edges.map((e) => ({
        ...e,
        points: cleanupPoints(e.points),
    }));

    const width = Math.max(
        maxColumns,
        nodes.reduce((max, n) => Math.max(max, n ? n.x + 1 : 0), 0),
    );

    return {
        nodes,
        edges: cleanedEdges,
        terminations,
        width,
        height: displayRows.length, // Total layout rows
        rows: displayRows,
    };
}
