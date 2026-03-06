/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GraphLayout } from './webview/graph-model';

/**
 * Renders a GraphLayout as ASCII text matching the `jj log` format.
 *
 * Each commit produces two lines:
 *   1. Node line: graph characters + node symbol + separator + commit info
 *   2. Description line: connector or continuation + separator + description
 *
 * Angled edges bend right before their target (matching jj log behavior).
 */
export function renderGraphToAscii(layout: GraphLayout): string {
    const { nodes, edges, rows } = layout;
    const nodesById = new Map(nodes.map((n) => [n.commitId, n]));

    /**
     * Check if a lane has a vertical pass-through at a given row.
     * For the "bend before target" model:
     * - Straight edges (x1==x2): vertical at lane x1 for y1 <= y <= y2
     * - Angled edges (x1!=x2): vertical at source lane x1 for y1 <= y <= y2-1
     *   (stays at source lane until bending just before target)
     */
    function hasVerticalAt(lane: number, y: number): boolean {
        return edges.some((e) => {
            const minY = Math.min(e.y1, e.y2);
            const maxY = Math.max(e.y1, e.y2);
            if (e.x1 === e.x2 && e.x1 === lane) {
                return minY <= y && y <= maxY;
            }
            if (e.x1 === lane && e.x1 !== e.x2) {
                return minY <= y && y <= maxY - 1;
            }
            return false;
        });
    }

    /**
     * Compute the active width at a row for text alignment.
     * Uses the same lifetime model as hasVerticalAt, plus accounts for
     * connector lines that extend to wider lanes.
     */
    function activeWidthAt(y: number): number {
        let w = 0;
        const node = nodes.find((n) => n.y === y);
        if (node) w = Math.max(w, node.x + 1);

        for (const e of edges) {
            const minY = Math.min(e.y1, e.y2);
            const maxY = Math.max(e.y1, e.y2);
            if (e.x1 === e.x2) {
                // Straight edge
                if (minY <= y && y <= maxY) {
                    w = Math.max(w, e.x1 + 1);
                }
            } else {
                // Angled edge: active at source lane x1 for y1 <= y <= y2-1
                if (minY <= y && y <= maxY - 1) {
                    w = Math.max(w, Math.max(e.x1, e.x2) + 1);
                }
            }
        }

        // Account for connector width: if there's a bend at boundary y→y+1,
        // the connector line spans both lanes.
        for (const e of edges) {
            if (e.y2 === y + 1 && e.x1 !== e.x2) {
                w = Math.max(w, Math.max(e.x1, e.x2) + 1);
            }
        }

        return w;
    }

    /**
     * Find connector edges that bend at the boundary between rows y and y+1.
     */
    function findConnectors(y: number): Array<{ x1: number; x2: number }> {
        const connectors: Array<{ x1: number; x2: number }> = [];
        for (const e of edges) {
            if (e.y2 === y + 1 && e.x1 !== e.x2) {
                connectors.push({ x1: e.x1, x2: e.x2 });
            }
        }
        return connectors;
    }

    /**
     * Build graph characters for a line.
     */
    function buildGraphChars(
        y: number,
        aw: number,
        nodeSymbol?: string,
        connectors?: Array<{ x1: number; x2: number }>,
    ): string {
        const node = nodesById.get(rows[y]?.commit_id || '');
        const nodeLane = node?.x ?? -1;
        let line = '';

        if (connectors && connectors.length > 0) {
            const conn = connectors[0];
            const narrowLane = Math.min(conn.x1, conn.x2);
            const wideLane = Math.max(conn.x1, conn.x2);
            const isJoin = conn.x2 < conn.x1;

            for (let lane = 0; lane < aw; lane++) {
                if (lane === narrowLane) {
                    const continuesDown = hasVerticalAt(narrowLane, y + 1) ||
                        nodes.some((n) => n.y === y + 1 && n.x === narrowLane);
                    line += continuesDown ? '├' : (isJoin ? '╰' : '╭');
                } else if (lane === wideLane) {
                    line += isJoin ? '╯' : '╮';
                } else if (lane > narrowLane && lane < wideLane) {
                    if (hasVerticalAt(lane, y)) {
                        line += '┼';
                    } else {
                        line += '─';
                    }
                } else {
                    if (hasVerticalAt(lane, y)) {
                        line += '│';
                    } else {
                        line += ' ';
                    }
                }

                if (lane < aw - 1) {
                    if (lane >= narrowLane && lane < wideLane) {
                        line += '─';
                    } else {
                        line += ' ';
                    }
                }
            }
        } else if (nodeSymbol) {
            for (let lane = 0; lane < aw; lane++) {
                if (lane === nodeLane) {
                    line += nodeSymbol;
                } else if (hasVerticalAt(lane, y)) {
                    line += '│';
                } else {
                    line += ' ';
                }
                if (lane < aw - 1) {
                    line += ' ';
                }
            }
        } else {
            for (let lane = 0; lane < aw; lane++) {
                if (hasVerticalAt(lane, y)) {
                    line += '│';
                } else {
                    line += ' ';
                }
                if (lane < aw - 1) {
                    line += ' ';
                }
            }
        }

        return line;
    }

    const output: string[] = [];

    for (let i = 0; i < rows.length; i++) {
        const commit = rows[i];
        const node = nodesById.get(commit.commit_id);
        if (!node) continue;

        const aw = activeWidthAt(i);

        let symbol: string;
        if (commit.is_working_copy) {
            symbol = '@';
        } else if (commit.is_immutable && commit.parents.length === 0) {
            symbol = '◆';
        } else {
            symbol = '○';
        }

        // Line 1: Node line with metadata
        const changeIdShort = commit.change_id_shortest || commit.change_id.substring(0, 8);
        const changeIdRest = commit.change_id.substring(changeIdShort.length, 8);
        const commitIdShort = commit.commit_id.substring(0, 8);
        const metaText = `${changeIdShort}${changeIdRest} ${commitIdShort}`;

        const nodeLine = buildGraphChars(i, aw, symbol);
        output.push(`${nodeLine}  ${metaText}`.trimEnd());

        // Line 2: Description/connector line
        const desc = commit.description.split('\n')[0] || '(no description set)';
        const connectors = findConnectors(i);

        if (connectors.length > 0) {
            const connLine = buildGraphChars(i, aw, undefined, connectors);
            output.push(`${connLine}  ${desc}`.trimEnd());
        } else if (i < rows.length - 1) {
            const contLine = buildGraphChars(i, aw);
            output.push(`${contLine}  ${desc}`.trimEnd());
        }
    }

    return output.map((line) => line.trimEnd()).join('\n');
}
