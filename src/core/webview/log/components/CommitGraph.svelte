<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { ActionPayload, CommitAction } from '../../../host/ipc/log-view-schemas';
import type { JjLogEntry } from '../../../jj-types';
import type { DragManager } from '../drag-manager.svelte';
import { computeGraphLayout } from '../graph-compute';
import { isElisionRow } from '../graph-model';
import {
    COMMIT_ROW_PADDING_LEFT,
    LANE_WIDTH,
    LEFT_MARGIN,
    ROW_HEIGHT_ELISION,
    ROW_HEIGHT_EXPANDED,
    ROW_HEIGHT_NORMAL,
} from '../layout-constants';
import { computeCompactRowMaxX, computeGap, computeGraphAreaWidth, computeMaxShortestIdLength } from '../layout-utils';
import { hasImmutableSelection } from '../utils/selection-utils';
import CommitNode from './CommitNode.svelte';
import GraphRail from './GraphRail.svelte';

interface Props {
    commits: JjLogEntry[];
    onAction: (action: string, payload: ActionPayload) => void;
    selectedCommitIds?: Set<string>;
    minChangeIdLength: number;
    graphLabelAlignment?: string;
    theme?: string;
    hiddenActions?: Set<CommitAction>;
    dragManager: DragManager;
}

let {
    commits,
    onAction,
    selectedCommitIds = new Set(),
    minChangeIdLength,
    graphLabelAlignment = 'aligned',
    theme = 'default',
    hiddenActions = new Set(),
    dragManager,
}: Props = $props();

let fontSize = $state(13);
$effect(() => {
    if (typeof document !== 'undefined') {
        const size = parseInt(getComputedStyle(document.body).fontSize, 10);
        if (size && size !== fontSize) {
            fontSize = size;
        }
    }
});

const GAP = $derived(computeGap(fontSize));
const layout = $derived(computeGraphLayout(commits, theme));
const displayRows = $derived(layout.rows || commits);

const compactPaddingMap = $derived.by(() => {
    if (graphLabelAlignment !== 'compact') {
        return undefined;
    }
    const map = new Map<number, number>();
    const rowMaxX = computeCompactRowMaxX(layout);
    rowMaxX.forEach((maxX, y) => {
        const padding = computeGraphAreaWidth(maxX + 1, LANE_WIDTH, LEFT_MARGIN, GAP);
        map.set(y, padding);
    });
    return map;
});

const rowOffsetsData = $derived.by(() => {
    let currentOffset = 0;
    const offsets: number[] = [];

    for (const row of displayRows) {
        offsets.push(currentOffset);
        let h: number;
        if (isElisionRow(row)) {
            h = ROW_HEIGHT_ELISION;
        } else {
            h = row.codeForgeChange ? ROW_HEIGHT_EXPANDED : ROW_HEIGHT_NORMAL;
        }
        currentOffset += h;
    }

    offsets.push(currentOffset);
    return { rowOffsets: offsets, totalHeight: currentOffset };
});

const maxShortestIdLength = $derived(computeMaxShortestIdLength(commits, minChangeIdLength));

const hasImmutable = $derived.by(() => {
    if (!selectedCommitIds || selectedCommitIds.size === 0) {
        return false;
    }
    return hasImmutableSelection(selectedCommitIds, commits);
});

const graphAreaWidth = $derived(computeGraphAreaWidth(layout.width, LANE_WIDTH, LEFT_MARGIN, GAP));
</script>

<div class="commit-graph">
    <!-- SVG Graph Overlay -->
    <GraphRail
        nodes={layout.nodes}
        edges={layout.edges}
        terminations={layout.terminations}
        width={layout.width}
        height={rowOffsetsData.totalHeight}
        rowOffsets={rowOffsetsData.rowOffsets}
        rows={displayRows}
        selectedNodes={selectedCommitIds}
    />

    <!-- Commit List (Text) -->
    <div class="commit-list" role="listbox" aria-label="Commit List">
        {#each displayRows as row, i (isElisionRow(row) ? `elision-${i}` : row.commit_id)}
            {@const isLastRow = i === displayRows.length - 1}
            {#if isElisionRow(row)}
                {@const graphOffset = compactPaddingMap?.get(i) ?? graphAreaWidth}
                {@const paddingLeft = graphOffset + COMMIT_ROW_PADDING_LEFT}
                <div
                    role="presentation"
                    class="elision-row"
                    style:padding-left={`${paddingLeft}px`}
                >
                    {#if !isLastRow}
                        <div class="elision-divider"></div>
                    {/if}
                </div>
            {:else}
                {@const isSelected = selectedCommitIds.has(row.change_id)}
                {@const height = row.codeForgeChange ? ROW_HEIGHT_EXPANDED : ROW_HEIGHT_NORMAL}
                {@const paddingLeft = compactPaddingMap?.get(i) ?? graphAreaWidth}
                <div
                    role="presentation"
                    class="commit-row-container"
                    style:height={`${height}px`}
                    style:padding-left={`${paddingLeft}px`}
                >
                    <CommitNode
                        commit={row}
                        onClick={(modifiers) =>
                            onAction('select', {
                                changeId: row.change_id,
                                changeIdShortest: row.change_id_shortest,
                                isDivergent: row.is_divergent,
                                changeIdOffset: row.change_id_offset,
                                ...modifiers,
                            })
                        }
                        {onAction}
                        {isSelected}
                        selectionCount={selectedCommitIds.size}
                        hasImmutableSelection={hasImmutable}
                        idDisplayLength={maxShortestIdLength}
                        {hiddenActions}
                        {dragManager}
                    />
                </div>
            {/if}
        {/each}
    </div>
</div>

<style>
    .commit-graph {
        position: relative;
        padding-bottom: 20px;
    }

    .commit-list {
        position: relative;
        z-index: 1;
    }

    .elision-row {
        height: 10px;
        display: flex;
        align-items: center;
    }

    .elision-divider {
        flex-grow: 1;
        height: 4px;
        background: linear-gradient(to right, var(--vscode-descriptionForeground) 0%, transparent 80%);
        opacity: 0.1;
        margin-right: 20px;
        border-radius: 2px;
    }

    .commit-row-container {
        display: flex;
        white-space: nowrap;
        overflow: hidden;
        align-items: flex-start;
    }
</style>

