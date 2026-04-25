/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as React from 'react';
import { match } from 'ts-pattern';
import type { GraphEdge, GraphNode, GraphPoint, GraphRow } from '../graph-model';
import { isElisionRow } from '../graph-model';
import {
    LANE_CENTER_X,
    LANE_WIDTH,
    LEFT_MARGIN,
    ROW_CENTER_Y,
    ROW_HEIGHT_ELISION,
    ROW_HEIGHT_NORMAL,
} from '../layout-constants';

interface GraphRailProps {
    nodes: GraphNode[];
    edges: GraphEdge[];
    terminations?: { x: number; y: number }[];
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
    terminations,
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
        const edgesWithBounds = edges.map((edge) => {
            let minX = Number.MAX_SAFE_INTEGER;
            let maxX = Number.MIN_SAFE_INTEGER;
            for (let i = 0; i < edge.points.length; i++) {
                const x = edge.points[i].x;
                if (x < minX) {
                    minX = x;
                }
                if (x > maxX) {
                    maxX = x;
                }
            }
            return { edge, minX, maxX };
        });
        return edgesWithBounds.sort((a, b) => b.minX - a.minX || b.maxX - a.maxX).map((item) => item.edge);
    }, [edges]);

    const getLayoutRowPixelY = React.useCallback(
        (point: GraphPoint): number => {
            const commitIndex = Math.floor(point.y);
            const isLinkRow = match(point)
                .with({ type: 'link' }, () => true)
                .with({ type: 'node' }, () => false)
                .exhaustive();

            const topY = rowOffsets[commitIndex] || 0;
            const row = rows[commitIndex];
            const isElision = isElisionRow(row);
            const thisCYOffset = isElision ? ROW_HEIGHT_ELISION / 2 : ROW_HEIGHT_NORMAL / 2;

            if (isLinkRow) {
                const nextRow = rows[commitIndex + 1];
                const nextIsElision = isElisionRow(nextRow);
                const nextCYOffset = nextIsElision ? ROW_HEIGHT_ELISION / 2 : ROW_HEIGHT_NORMAL / 2;

                const bottomY = rowOffsets[commitIndex + 1] || topY + ROW_HEIGHT_NORMAL;
                const thisCY = topY + thisCYOffset;
                const nextCY = bottomY + nextCYOffset;
                return thisCY + (nextCY - thisCY) / 2;
            } else {
                return topY + thisCYOffset;
            }
        },
        [rowOffsets, rows],
    );

    const getPixelX = (lane: number) => lane * W + CX + LEFT_MARGIN;

    // Render Edges
    const renderEdge = (edge: GraphEdge, index: number) => {
        const { points, color } = edge;
        if (!points || points.length < 2) {
            return null;
        }

        // Apply trailing extension logic to the very last point
        const displayPoints = [...points];
        const lastP = displayPoints[displayPoints.length - 1];
        const isTrailing = lastP.y >= rows.length;

        let trailingY = getLayoutRowPixelY(lastP);
        if (isTrailing) {
            const lastRowIndex = rows.length - 1;
            const isLastRowElision = isElisionRow(rows[lastRowIndex]);

            if (isLastRowElision) {
                trailingY = (rowOffsets[lastRowIndex] || 0) + ELISION_ROW_HEIGHT / 2;
            } else {
                trailingY = (rowOffsets[lastRowIndex] || 0) + CY_OFFSET + (edge.isElided ? 24 : 12);
            }
        }

        let d = `M ${getPixelX(displayPoints[0].x)} ${getLayoutRowPixelY(displayPoints[0])} `;

        for (let j = 1; j < displayPoints.length - 1; j++) {
            const prev = displayPoints[j - 1];
            const curr = displayPoints[j];
            const next = displayPoints[j + 1];

            const px = getPixelX(prev.x);
            const py = getLayoutRowPixelY(prev);
            const cx = getPixelX(curr.x);
            const cy = getLayoutRowPixelY(curr);

            const nx = getPixelX(next.x);
            let ny = getLayoutRowPixelY(next);
            if (j + 1 === displayPoints.length - 1 && isTrailing) {
                ny = trailingY;
            }

            // Universal orthogonal rounded corner algorithm
            const dx1 = cx - px;
            const dy1 = cy - py;
            const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

            const dx2 = nx - cx;
            const dy2 = ny - cy;
            const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

            // Radius cannot be larger than half the shortest segment
            const r = Math.min(R, len1 / 2, len2 / 2);

            if (r === 0) {
                d += `L ${cx} ${cy} `;
                continue;
            }

            const ux = cx === px ? 0 : px < cx ? -1 : 1;
            const uy = cy === py ? 0 : py < cy ? -1 : 1;
            const startX = cx + ux * r;
            const startY = cy + uy * r;

            const vx = nx === cx ? 0 : cx < nx ? 1 : -1;
            const vy = ny === cy ? 0 : cy < ny ? 1 : -1;
            const endX = cx + vx * r;
            const endY = cy + vy * r;

            d += `L ${startX} ${startY} `;
            d += `Q ${cx} ${cy} ${endX} ${endY} `;
        }

        // Final segment
        const last = displayPoints[displayPoints.length - 1];
        const finalX = getPixelX(last.x);
        const finalY = isTrailing ? trailingY : getLayoutRowPixelY(last);
        d += `L ${finalX} ${finalY} `;

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
        const cx = getPixelX(node.x);
        const cy = getLayoutRowPixelY({ type: 'node', x: node.x, y: node.y });

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

        let content: React.ReactNode = null;
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
            aria-label="Commit graph"
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 0 }}
        >
            {sortedEdges.map((edge, i) => renderEdge(edge, i))}
            {terminations?.map((term) => {
                const mx = getPixelX(term.x);
                const my =
                    term.y >= rows.length
                        ? (rowOffsets[rows.length - 1] || 0) + CY_OFFSET + 24
                        : getLayoutRowPixelY({ type: 'node', x: term.x, y: term.y });
                return (
                    <g key={`term-${term.x}-${term.y}`} transform={`translate(${mx}, ${my})`}>
                        <rect x="-5" y="-6" width="10" height="12" fill="var(--vscode-sideBar-background)" />
                        <path
                            d="M -4,1 C -4,-2 -1,-2 0,0 C 1,2 4,2 4,-1"
                            stroke="var(--vscode-descriptionForeground)"
                            strokeWidth="2"
                            fill="none"
                            strokeLinecap="round"
                        />
                    </g>
                );
            })}
            {nodes.map((node) => renderNode(node))}
        </svg>
    );
};
