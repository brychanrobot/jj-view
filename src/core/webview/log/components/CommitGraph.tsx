/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as React from 'react';
import type { ActionPayload, CommitAction } from '../../../common/ipc/log-view-schemas';
import type { JjLogEntry } from '../../../jj-types';
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
import type { DragActionModifier } from '../utils/drag-modifiers';
import { hasImmutableSelection } from '../utils/selection-utils';
import { CommitNode } from './CommitNode';
import { GraphRail } from './GraphRail';

interface CommitGraphProps {
    commits: JjLogEntry[];
    onAction: (action: string, payload: ActionPayload) => void;
    selectedCommitIds?: Set<string>;
    minChangeIdLength: number;
    graphLabelAlignment?: string;
    theme?: string;
    hiddenActions?: Set<CommitAction>;
    activeModifier?: DragActionModifier;
}

export const CommitGraph: React.FC<CommitGraphProps> = ({
    commits,
    onAction,
    selectedCommitIds,
    minChangeIdLength,
    graphLabelAlignment = 'aligned',
    theme = 'default',
    hiddenActions,
    activeModifier,
}) => {
    // Total graph width calculation
    // Dynamic sizing based on font
    // Fallback to 13px if not available
    const [fontSize, setFontSize] = React.useState<number>(13);
    React.useLayoutEffect(() => {
        if (typeof document !== 'undefined') {
            const size = parseInt(getComputedStyle(document.body).fontSize, 10);
            if (size && size !== fontSize) {
                setFontSize(size);
            }
        }
    }, [fontSize]);
    const GAP = computeGap(fontSize);

    const layout = React.useMemo(() => computeGraphLayout(commits, theme), [commits, theme]);
    const displayRows = layout.rows || commits;

    const compactPaddingMap = React.useMemo(() => {
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
    }, [layout, graphLabelAlignment, GAP]);

    // Calculate Row Offsets
    // This allows us to have variable height rows while keeping the graph aligned.
    const { rowOffsets, totalHeight } = React.useMemo(() => {
        let currentOffset = 0;
        const offsets: number[] = [];

        displayRows.forEach((row) => {
            offsets.push(currentOffset);
            // Height logic matching the renderer in CommitNode
            let height: number;
            if (isElisionRow(row)) {
                height = ROW_HEIGHT_ELISION;
            } else {
                height = row.codeForgeChange ? ROW_HEIGHT_EXPANDED : ROW_HEIGHT_NORMAL;
            }
            currentOffset += height;
        });

        // Push one last offset for the total height boundary (useful for empty space calculations if needed)
        offsets.push(currentOffset);

        return { rowOffsets: offsets, totalHeight: currentOffset };
    }, [displayRows]);

    // Determine the max shortest ID length to display
    const maxShortestIdLength = React.useMemo(
        () => computeMaxShortestIdLength(commits, minChangeIdLength),
        [commits, minChangeIdLength],
    );

    const hasImmutable = React.useMemo(() => {
        if (!selectedCommitIds || selectedCommitIds.size === 0) {
            return false;
        }
        return hasImmutableSelection(selectedCommitIds, commits);
    }, [commits, selectedCommitIds]);

    // Padding-left for the text area
    const graphAreaWidth = computeGraphAreaWidth(layout.width, LANE_WIDTH, LEFT_MARGIN, GAP);

    const renderElisionRow = (i: number, isLastRow: boolean) => {
        // Offset to match the start of the Change ID in CommitNode
        const graphOffset = compactPaddingMap?.get(i) ?? graphAreaWidth;
        const paddingLeft = graphOffset + COMMIT_ROW_PADDING_LEFT;

        return (
            <div
                key={`elision-${i}`}
                role="presentation"
                style={{
                    height: ROW_HEIGHT_ELISION,
                    paddingLeft,
                    display: 'flex',
                    alignItems: 'center',
                }}
            >
                {!isLastRow && (
                    <div
                        style={{
                            flexGrow: 1,
                            height: '4px',
                            background:
                                'linear-gradient(to right, var(--vscode-descriptionForeground) 0%, transparent 80%)',
                            opacity: 0.1,
                            marginRight: '20px',
                            borderRadius: '2px',
                        }}
                    />
                )}
            </div>
        );
    };

    return (
        <div className="commit-graph" style={{ position: 'relative', paddingBottom: '20px' }}>
            {/* SVG Graph Overlay */}
            <GraphRail
                nodes={layout.nodes}
                edges={layout.edges}
                terminations={layout.terminations}
                width={layout.width}
                height={totalHeight}
                rowOffsets={rowOffsets}
                rows={displayRows}
                selectedNodes={selectedCommitIds}
            />

            {/* Commit List (Text) */}
            <div style={{ position: 'relative', zIndex: 1 }} role="listbox" aria-label="Commit List">
                {displayRows.map((row, i) => {
                    const isLastRow = i === displayRows.length - 1;
                    if (isElisionRow(row)) {
                        return renderElisionRow(i, isLastRow);
                    }

                    const isSelected = selectedCommitIds?.has(row.change_id);
                    const height = row.codeForgeChange ? ROW_HEIGHT_EXPANDED : ROW_HEIGHT_NORMAL;
                    const paddingLeft = compactPaddingMap?.get(i) ?? graphAreaWidth;
                    return (
                        <div
                            key={row.commit_id}
                            role="presentation"
                            style={{
                                height: height,
                                paddingLeft: paddingLeft,
                                display: 'flex',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                alignItems: 'flex-start', // Align with top primary row
                            }}
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
                                onAction={onAction}
                                isSelected={isSelected}
                                selectionCount={selectedCommitIds?.size || 0}
                                hasImmutableSelection={hasImmutable}
                                idDisplayLength={maxShortestIdLength}
                                hiddenActions={hiddenActions}
                                activeModifier={activeModifier}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
