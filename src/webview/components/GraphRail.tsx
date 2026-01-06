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

import * as React from 'react';
import { GraphNode, GraphEdge } from '../graph-model';

interface GraphRailProps {
    nodes: GraphNode[];
    edges: GraphEdge[];
    width: number; // in lanes
    height: number; // in rows
    selectedNodes?: Set<string>;
}

const W = 16;
const H = 28;
const CX = W / 2;
const CY = H / 2;
const LEFT_MARGIN = 12; // Shift graph right to prevent clipping of halos
const R = 8; // Max radius (W/2) for smooth curves

export const GraphRail: React.FC<GraphRailProps> = ({ nodes, edges, width, height, selectedNodes }) => {
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
        const sy = y1 * H + CY;
        const ex = x2 * W + CX + LEFT_MARGIN;
        const ey = y2 * H + CY;

        let d = '';

        if (x1 === x2) {
            // Straight Vertical
            d = `M ${sx} ${sy} L ${ex} ${ey}`;
        } else {
            // Rail Routing
            // Turn at the boundary between rows (y1 + 1)
            const midY = (y1 + 1) * H;

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
        const cy = node.y * H + CY;
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
    const svgHeight = height * H;

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
