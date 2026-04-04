/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as React from 'react';
import { GraphEdge, GraphNode, GraphRow } from '../graph-model';
import { LANE_WIDTH, ROW_HEIGHT_ELISION, LEFT_MARGIN, LANE_CENTER_X, ROW_CENTER_Y } from '../layout-constants';

interface GraphRailProps {
    nodes: GraphNode[];
    edges: GraphEdge[];
    width: number; // in lanes
    height: number; // total height in pixels
    rowOffsets: number[]; // Exact Y position for each row index
    rows: GraphRow[];
    selectedNodes?: Set<string>;
}

const W = LANE_WIDTH;
const CX = LANE_CENTER_X;
const CY_OFFSET = ROW_CENTER_Y;
const ELISION_ROW_HEIGHT = ROW_HEIGHT_ELISION;
const R = 8; // Max radius (W/2) for smooth curves
const BOTTOM_PADDING = 20; // Extra room for trailing elision markers at the bottom

export const GraphRail: React.FC<GraphRailProps> = ({
    nodes,
    edges,
    width,
    height,
    rowOffsets,
    rows,
    selectedNodes,
}) => {
    // Layering: Leftmost lanes (lower x) should render visually on TOP.
    // SVG renders elements in order, so the last element appears on top.
    // Therefore, we want lower x values to come LAST in the array.
    // 1. Primary Sort: Sort by min(x1, x2) DESCENDING.
    // 2. Secondary Sort: If the leftmost lane is the same, sort by max(x1, x2) DESCENDING.
    //    This ensures lines extending further to the right (higher max) render underneath
    //    lines that stay strictly in the leftmost lane.
    const sortedEdges = React.useMemo(() => {
        return [...edges].sort((a, b) => {
            return Math.min(b.x1, b.x2) - Math.min(a.x1, a.x2) || Math.max(b.x1, b.x2) - Math.max(a.x1, a.x2);
        });
    }, [edges]);

    // Render Edges
    const renderEdge = (edge: GraphEdge, index: number) => {
        const { x1, y1, x2, y2, color } = edge;
        const sx = x1 * W + CX + LEFT_MARGIN;
        // Start Y is based on row offset + centering in header
        const sy = (rowOffsets[y1] || 0) + CY_OFFSET;

        const ex = x2 * W + CX + LEFT_MARGIN;
        // End Y
        const isTrailing = y2 >= rows.length;
        // Trailing edges extend past the last row. If the last row is an elision row, they should end there.
        const lastRowIndex = rows.length - 1;
        const isLastRowElision =
            rows[lastRowIndex] && 'type' in rows[lastRowIndex] && rows[lastRowIndex].type === 'elision';

        let ey: number;
        if (isTrailing) {
            if (isLastRowElision) {
                // End in the middle of the elision row
                ey = (rowOffsets[lastRowIndex] || 0) + ELISION_ROW_HEIGHT / 2;
            } else {
                ey = (rowOffsets[y2] || rowOffsets[lastRowIndex] || 0) + 12;
            }
        } else {
            ey = (rowOffsets[y2] || 0) + CY_OFFSET;
        }

        let d = '';

        if (x1 === x2) {
            // Straight Vertical
            d = `M ${sx} ${sy} L ${ex} ${ey}`;
        } else {
            // Rail Routing
            const cY = edge.curveY ?? y2;
            let midY: number;

            if (rowOffsets[cY] !== undefined) {
                // S-curve crosses boundary right above the curve row
                midY = rowOffsets[cY];
            } else {
                // If it curves offscreen, use ey but subtract the offset to get the row boundary
                midY = isTrailing ? ey : ey - CY_OFFSET;
            }

            // Direction for horizontal
            const dirX = x2 > x1 ? 1 : -1;

            // Start -> Vertical to Turn
            d += `M ${sx} ${sy}`;
            d += ` L ${sx} ${midY - R}`;

            // Curve 1 (Vertical to Horizontal)

            // Quadratic Bezier (Q): Q control-point-x control-point-y end-x end-y
            // Start: (sx, midY - R)
            // Control: (sx, midY) - Corner
            // End: (sx + R*dirX, midY)
            d += ` Q ${sx} ${midY} ${sx + R * dirX} ${midY}`;

            // Horizontal Line
            // If adjacent lanes (delta=1), len = W = 2*R.
            // start + 2*R*dirX = start + W*dirX = ex.
            // So horizontal segment is length 0. Perfect S.
            // If delta > 1, straight line exists.
            d += ` L ${ex - R * dirX} ${midY}`;

            // Curve 2 (Horizontal to Vertical)
            // Start: (ex - R*dirX, midY)
            // Control: (ex, midY)
            // End: (ex, midY + R)
            d += ` Q ${ex} ${midY} ${ex} ${midY + R}`;

            if (!edge.isJoining) {
                // Vertical to End
                d += ` L ${ex} ${ey}`;
            }
        }

        const ElisionMarker = () => {
            if (!edge.isElided) return null;

            // Find the elision row for this edge.
            // It should be either y1 + 1 (standard elision after child)
            // or the last row (if it's a trailing edge).
            let elisionRowIndex = -1;
            const nextRow = rows[y1 + 1];
            if (nextRow && 'type' in nextRow && nextRow.type === 'elision') {
                elisionRowIndex = y1 + 1;
            } else if (isTrailing && isLastRowElision) {
                elisionRowIndex = lastRowIndex;
            }

            if (elisionRowIndex === -1) return null;

            const mx = sx;
            const my = rowOffsets[elisionRowIndex] + ELISION_ROW_HEIGHT / 2;

            return (
                <g key={`elision-${index}`} transform={`translate(${mx}, ${my})`}>
                    {/* Background cutout to create a clean gap in the colored line */}
                    <rect x="-5" y="-6" width="10" height="12" fill="var(--vscode-sideBar-background)" />
                    {/* Tilde marker ~ in disabled gray */}
                    <path
                        d="M -4,1 C -4,-2 -1,-2 0,0 C 1,2 4,2 4,-1"
                        stroke="var(--vscode-descriptionForeground)"
                        strokeWidth="2"
                        fill="none"
                        strokeLinecap="round"
                    />
                </g>
            );
        };

        return (
            <React.Fragment key={`edge-group-${index}`}>
                <path d={d} stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                <ElisionMarker />
            </React.Fragment>
        );
    };

    // Render Nodes
    const renderNode = (node: GraphNode) => {
        const cx = node.x * W + CX + LEFT_MARGIN;
        // Node Y is strictly based on the offset table
        const cy = (rowOffsets[node.y] || 0) + CY_OFFSET;

        const isSelected = selectedNodes?.has(node.changeId);

        const Halo = () => (
            <circle
                cx={cx}
                cy={cy}
                r="9"
                fill="none"
                stroke="var(--vscode-list-activeSelectionForeground)"
                strokeWidth="2"
                style={{ opacity: 0.6 }}
            />
        );

        let content;
        if (node.isCurrentWorkingCopy) {
            content = (
                <>
                    <circle cx={cx} cy={cy} r="8" fill="var(--vscode-sideBar-background)" />
                    <text
                        x={cx}
                        y={cy}
                        dy="0.3em"
                        textAnchor="middle"
                        fill={node.conflict ? 'var(--vscode-charts-red)' : 'var(--vscode-editor-foreground)'}
                        style={{
                            fontFamily: 'var(--vscode-editor-font-family)',
                            fontWeight: 'bold',
                            fontSize: '14px',
                            pointerEvents: 'none',
                            userSelect: 'none',
                        }}
                    >
                        @
                    </text>
                </>
            );
        } else if (node.conflict) {
            content = (
                <>
                    <circle cx={cx} cy={cy} r="6" fill="var(--vscode-sideBar-background)" />
                    <line
                        x1={cx - 3}
                        y1={cy - 3}
                        x2={cx + 3}
                        y2={cy + 3}
                        stroke="var(--vscode-charts-red)"
                        strokeWidth="2"
                        strokeLinecap="round"
                    />
                    <line
                        x1={cx + 3}
                        y1={cy - 3}
                        x2={cx - 3}
                        y2={cy + 3}
                        stroke="var(--vscode-charts-red)"
                        strokeWidth="2"
                        strokeLinecap="round"
                    />
                </>
            );
        } else if (node.isEmpty) {
            content = node.isImmutable ? (
                <polygon
                    points={`${cx},${cy - 6} ${cx + 6},${cy} ${cx},${cy + 6} ${cx - 6},${cy}`}
                    fill="var(--vscode-sideBar-background)"
                    stroke={node.color}
                    strokeWidth="2"
                    strokeLinejoin="round"
                />
            ) : (
                <circle
                    cx={cx}
                    cy={cy}
                    r="5"
                    fill="var(--vscode-sideBar-background)"
                    stroke={node.color}
                    strokeWidth="2"
                />
            );
        } else {
            content = node.isImmutable ? (
                <polygon
                    points={`${cx},${cy - 6} ${cx + 6},${cy} ${cx},${cy + 6} ${cx - 6},${cy}`}
                    fill={node.color}
                    stroke={node.color}
                    strokeWidth="2"
                    strokeLinejoin="round"
                />
            ) : (
                <circle cx={cx} cy={cy} r="5" fill={node.color} stroke={node.color} strokeWidth="2" />
            );
        }

        return (
            <g key={node.commitId}>
                {isSelected && <Halo />}
                {content}
            </g>
        );
    };

    // Determine graph SVG dimensions
    const svgWidth = width * W + LEFT_MARGIN + W; // Width + margin + extra buffer
    // SVG Height includes padding for trailing markers
    const svgHeight = height + BOTTOM_PADDING;

    return (
        <svg
            width={svgWidth}
            height={svgHeight}
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 0 }}
        >
            {sortedEdges.map((edge, i) => renderEdge(edge, i))}
            {nodes.map((node) => renderNode(node))}
        </svg>
    );
};
