<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { GraphEdge, GraphNode, GraphPoint, GraphRow } from '../graph-model';
import { isElisionRow } from '../graph-model';
import {
    LANE_CENTER_X,
    LANE_WIDTH,
    LEFT_MARGIN,
    ROW_CENTER_Y,
    ROW_HEIGHT_ELISION,
    ROW_HEIGHT_EXPANDED,
    ROW_HEIGHT_NORMAL,
} from '../layout-constants';

interface Props {
    nodes: GraphNode[];
    edges: GraphEdge[];
    terminations?: { x: number; y: number }[];
    width: number;
    height: number;
    rowOffsets: number[];
    rows: GraphRow[];
    selectedNodes?: Set<string>;
}

let { nodes, edges, terminations = [], width, height, rowOffsets, rows, selectedNodes = new Set() }: Props = $props();

const W = LANE_WIDTH;
const CX = LANE_CENTER_X;
const CY_OFFSET = ROW_CENTER_Y;
const ELISION_ROW_HEIGHT = ROW_HEIGHT_ELISION;
const R = 8;
const BOTTOM_PADDING = 20;

const sortedEdges = $derived.by(() => {
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
});

function getLayoutRowPixelY(point: GraphPoint): number {
    const commitIndex = Math.floor(point.y);
    const isLinkRow = point.type === 'link';

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
    }
    return topY + thisCYOffset;
}

function getPixelX(lane: number): number {
    return lane * W + CX + LEFT_MARGIN;
}

function computeEdgePath(edge: GraphEdge): string | null {
    const { points } = edge;
    if (!points || points.length < 2) {
        return null;
    }

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
            const lastRow = rows[lastRowIndex];
            const lastRowHeight =
                lastRow && !isElisionRow(lastRow) && lastRow.codeForgeChange ? ROW_HEIGHT_EXPANDED : ROW_HEIGHT_NORMAL;
            const baseOffset = lastRowHeight === ROW_HEIGHT_EXPANDED ? ROW_HEIGHT_EXPANDED - 2 : CY_OFFSET + 12;
            trailingY = (rowOffsets[lastRowIndex] || 0) + baseOffset + (edge.isElided ? 12 : 0);
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

        const dx1 = cx - px;
        const dy1 = cy - py;
        const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

        const dx2 = nx - cx;
        const dy2 = ny - cy;
        const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

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

    const last = displayPoints[displayPoints.length - 1];
    const finalX = getPixelX(last.x);
    const finalY = isTrailing ? trailingY : getLayoutRowPixelY(last);
    d += `L ${finalX} ${finalY} `;

    return d;
}

const svgWidth = $derived(width * W + LEFT_MARGIN + W);
const svgHeight = $derived(height + BOTTOM_PADDING);
</script>

<svg
    width={svgWidth}
    height={svgHeight}
    aria-label="Commit graph"
    class="graph-svg"
>
    <!-- Edges -->
    {#each sortedEdges as edge, i (`edge-${i}`)}
        {@const pathData = computeEdgePath(edge)}
        {#if pathData}
            <path
                d={pathData}
                stroke={edge.color}
                stroke-width="2"
                fill="none"
                stroke-linecap="round"
                stroke-linejoin="round"
            />
        {/if}
    {/each}

    <!-- Terminations -->
    {#each terminations as term (`term-${term.x}-${term.y}`)}
        {@const mx = getPixelX(term.x)}
        {@const lastRow = rows[rows.length - 1]}
        {@const lastRowOffset =
            lastRow && !isElisionRow(lastRow) && lastRow.codeForgeChange
                ? ROW_HEIGHT_EXPANDED + 10
                : CY_OFFSET + 24}
        {@const my =
            term.y >= rows.length
                ? (rowOffsets[rows.length - 1] || 0) + lastRowOffset
                : getLayoutRowPixelY({ type: 'node', x: term.x, y: term.y })}
        <g transform={`translate(${mx}, ${my})`}>
            <rect x="-5" y="-6" width="10" height="12" fill="var(--vscode-sideBar-background)" />
            <path
                d="M -4,1 C -4,-2 -1,-2 0,0 C 1,2 4,2 4,-1"
                stroke="var(--vscode-descriptionForeground)"
                stroke-width="2"
                fill="none"
                stroke-linecap="round"
            />
        </g>
    {/each}

    <!-- Nodes -->
    {#each nodes as node (node.commitId)}
        {@const cx = getPixelX(node.x)}
        {@const cy = getLayoutRowPixelY({ type: 'node', x: node.x, y: node.y })}
        {@const isSelected = selectedNodes.has(node.changeId)}
        <g data-commit-id={node.commitId}>
            {#if isSelected}
                <circle
                    {cx}
                    {cy}
                    r="9"
                    fill="none"
                    stroke="var(--vscode-list-activeSelectionForeground)"
                    stroke-width="2"
                    style:opacity="0.6"
                />
            {/if}

            {#if node.isCurrentWorkingCopy}
                <circle {cx} {cy} r="8" fill="var(--vscode-sideBar-background)" />
                <text
                    x={cx}
                    y={cy}
                    dy="0.3em"
                    text-anchor="middle"
                    fill={node.conflict ? 'var(--vscode-charts-red)' : 'var(--vscode-editor-foreground)'}
                    class="node-working-copy-text"
                >
                    @
                </text>
            {:else if node.isHidden}
                <g transform={`translate(${cx}, ${cy})`}>
                    <circle cx="0" cy="0" r="8" fill="var(--vscode-sideBar-background)" />
                    <path
                        data-ghost="true"
                        d="M -6,7 C -6,-2 -6,-6 0,-6 C 6,-6 6,-2 6,7 L 4,4 L 2,7 L 0,4 L -2,7 L -4,4 Z"
                        fill="var(--vscode-descriptionForeground)"
                        fill-opacity="0.4"
                        stroke="var(--vscode-descriptionForeground)"
                        stroke-width="1.5"
                        stroke-opacity="1"
                        stroke-linejoin="round"
                    />
                    <circle cx="-2" cy="-1.5" r="1.5" fill="var(--vscode-sideBar-background)" />
                    <circle cx="2" cy="-1.5" r="1.5" fill="var(--vscode-sideBar-background)" />
                </g>
            {:else if node.conflict}
                <circle {cx} {cy} r="6" fill="var(--vscode-sideBar-background)" />
                <line
                    x1={cx - 3}
                    y1={cy - 3}
                    x2={cx + 3}
                    y2={cy + 3}
                    stroke="var(--vscode-charts-red)"
                    stroke-width="2"
                    stroke-linecap="round"
                />
                <line
                    x1={cx + 3}
                    y1={cy - 3}
                    x2={cx - 3}
                    y2={cy + 3}
                    stroke="var(--vscode-charts-red)"
                    stroke-width="2"
                    stroke-linecap="round"
                />
            {:else if node.isEmpty}
                {#if node.isImmutable}
                    <polygon
                        points={`${cx},${cy - 6} ${cx + 6},${cy} ${cx},${cy + 6} ${cx - 6},${cy}`}
                        fill="var(--vscode-sideBar-background)"
                        stroke={node.color}
                        stroke-width="2"
                        stroke-linejoin="round"
                    />
                {:else}
                    <circle
                        {cx}
                        {cy}
                        r="5"
                        fill="var(--vscode-sideBar-background)"
                        stroke={node.color}
                        stroke-width="2"
                    />
                {/if}
            {:else if node.isImmutable}
                <polygon
                    points={`${cx},${cy - 6} ${cx + 6},${cy} ${cx},${cy + 6} ${cx - 6},${cy}`}
                    fill={node.color}
                    stroke={node.color}
                    stroke-width="2"
                    stroke-linejoin="round"
                />
            {:else}
                <circle {cx} {cy} r="5" fill={node.color} stroke={node.color} stroke-width="2" />
            {/if}
        </g>
    {/each}
</svg>

<style>
    .graph-svg {
        position: absolute;
        top: 0;
        left: 0;
        pointer-events: none;
        z-index: 0;
    }

    .node-working-copy-text {
        font-family: var(--vscode-editor-font-family);
        font-weight: bold;
        font-size: 14px;
        pointer-events: none;
        user-select: none;
    }
</style>
