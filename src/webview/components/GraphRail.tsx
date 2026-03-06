/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import { GraphNode, GraphEdge } from '../graph-model';

interface GraphRailProps {
    nodes: GraphNode[];
    edges: GraphEdge[];
    width: number; // in lanes
    height: number; // total height in pixels
    rowOffsets: number[]; // Exact Y position for each row index
    selectedNodes?: Set<string>;
}

const W = 16;
const ROW_HEADER_HEIGHT = 28; // The "primary" line height where the graph lives
const CX = W / 2;
const CY_OFFSET = ROW_HEADER_HEIGHT / 2; // Graph is centered in the primary line (14px)
const LEFT_MARGIN = 12; // Shift graph right to prevent clipping of halos
const R = 8; // Max radius (W/2) for smooth curves

export const GraphRail: React.FC<GraphRailProps> = ({ nodes, edges, width, height, rowOffsets, selectedNodes }) => {
    // Layering: Leftmost lanes (lower x) should be on TOP.
    // SVG renders last-child on top. So we verify lower x comes LAST.
    // Sort edges by min(x1, x2) DESCENDING.
    const sortedEdges = React.useMemo(() => {
        return [...edges].sort((a, b) => {
            const minA = Math.min(a.x1, a.x2);
            const minB = Math.min(b.x1, b.x2);
            return minB - minA; // Descending
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
        const ey = (rowOffsets[y2] || 0) + CY_OFFSET;

        let d = '';

        if (x1 === x2) {
            // Straight Vertical
            d = `M ${sx} ${sy} L ${ex} ${ey}`;
        } else {
            // Rail Routing: Bend right BEFORE the target row to match jj log.
            // The edge stays vertical at the source lane, then bends at the
            // boundary just before the target row.
            const targetRowY = rowOffsets[y2] || ey;
            const midY = targetRowY;

            // Direction for horizontal
            const dirX = x2 > x1 ? 1 : -1;

            // Start -> Vertical down at source lane
            d += `M ${sx} ${sy}`;
            d += ` L ${sx} ${midY - R}`;

            // Curve 1 (Vertical to Horizontal)
            d += ` Q ${sx} ${midY} ${sx + R * dirX} ${midY}`;

            // Horizontal Line
            d += ` L ${ex - R * dirX} ${midY}`;

            // Curve 2 (Horizontal to Vertical)
            d += ` Q ${ex} ${midY} ${ex} ${midY + R}`;

            // Vertical to End
            d += ` L ${ex} ${ey}`;
        }

        return (
            <path
                key={`edge-${index}`}
                d={d}
                stroke={color}
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
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

        if (node.isWorkingCopy) {
            return (
                <g key={node.commitId}>
                    {isSelected && <Halo />}
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
                </g>
            );
        }

        if (node.conflict) {
            return (
                <g key={node.commitId}>
                    {isSelected && <Halo />}
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
                </g>
            );
        }

        if (node.isEmpty) {
            return (
                <circle
                    key={node.commitId}
                    cx={cx}
                    cy={cy}
                    r="5"
                    fill="var(--vscode-sideBar-background)"
                    stroke={node.color}
                    strokeWidth="2"
                    style={{ opacity: 0.8 }}
                />
            );
        }

        if (isSelected) {
            return (
                <g key={node.commitId}>
                    <Halo />
                    <circle cx={cx} cy={cy} r="5" fill={node.color} stroke={node.color} strokeWidth="2" />
                </g>
            );
        }

        return (
            <circle key={node.commitId} cx={cx} cy={cy} r="5" fill={node.color} stroke={node.color} strokeWidth="2" />
        );
    };

    // Determine graph SVG dimensions
    const svgWidth = width * W + LEFT_MARGIN + W; // Width + margin + extra buffer
    // SVG Height is now passed in explicitly based on total row height
    const svgHeight = height;

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
