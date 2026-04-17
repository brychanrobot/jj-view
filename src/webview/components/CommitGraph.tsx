/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as React from 'react';
import { ActionPayload, CommitAction, JjLogEntry } from '../../jj-types';
import { computeGraphLayout } from '../graph-compute';
import {
    LANE_WIDTH,
    ROW_HEIGHT_NORMAL,
    ROW_HEIGHT_EXPANDED,
    ROW_HEIGHT_ELISION,
    LEFT_MARGIN,
    COMMIT_ROW_PADDING_LEFT,
} from '../layout-constants';
import { computeCompactRowMaxX, computeGap, computeGraphAreaWidth, computeMaxShortestIdLength } from '../layout-utils';
import { CommitNode } from './CommitNode';
import { GraphRail } from './GraphRail';

interface CommitGraphProps {
    commits: any[];
    onAction: (action: string, payload: ActionPayload) => void;
    selectedCommitIds?: Set<string>;
    minChangeIdLength: number;
    graphLabelAlignment?: string;
    theme?: string;
    hiddenActions?: Set<CommitAction>;
}

export const CommitGraph: React.FC<CommitGraphProps> = ({
    commits,
    onAction,
    selectedCommitIds,
    minChangeIdLength,
    graphLabelAlignment = 'aligned',
    theme = 'default',
    hiddenActions,
}) => {
    // Total graph width calculation
    // Dynamic sizing based on font
    // Fallback to 13px if not available
    const fontSize = typeof document !== 'undefined' ? parseInt(getComputedStyle(document.body).fontSize) || 13 : 13;
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
    }, [layout, graphLabelAlignment, GAP, LANE_WIDTH, LEFT_MARGIN]);

    // Calculate Row Offsets
    // This allows us to have variable height rows while keeping the graph aligned.
    const { rowOffsets, totalHeight } = React.useMemo(() => {
        let currentOffset = 0;
        const offsets: number[] = [];

        displayRows.forEach((row) => {
            offsets.push(currentOffset);
            // Height logic matching the renderer in CommitNode
            let height: number;
            if ('type' in row && row.type === 'elision') {
                height = ROW_HEIGHT_ELISION;
            } else {
                const commit = row as JjLogEntry;
                height = commit.gerritCl ? ROW_HEIGHT_EXPANDED : ROW_HEIGHT_NORMAL;
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

    const hasImmutableSelection = React.useMemo(() => {
        if (!selectedCommitIds || selectedCommitIds.size === 0) {
            return false;
        }
        // Check ALL commits, not just displayRows, to ensure correctness even if some are off-screen
        return commits.some((c) => selectedCommitIds.has(c.change_id) && c.is_immutable);
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
                width={layout.width}
                height={totalHeight}
                rowOffsets={rowOffsets}
                rows={displayRows}
                selectedNodes={selectedCommitIds}
            />

            {/* Commit List (Text) */}
            <div style={{ position: 'relative', zIndex: 1 }}>
                {displayRows.map((row, i) => {
                    const isLastRow = i === displayRows.length - 1;
                    if (row && 'type' in row && row.type === 'elision') {
                        return renderElisionRow(i, isLastRow);
                    }

                    const commit = row as JjLogEntry;
                    const isSelected = selectedCommitIds?.has(commit.change_id);
                    const height = commit.gerritCl ? ROW_HEIGHT_EXPANDED : ROW_HEIGHT_NORMAL;
                    const paddingLeft = compactPaddingMap?.get(i) ?? graphAreaWidth;
                    return (
                        <div
                            key={commit.commit_id}
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
                                commit={commit}
                                onClick={(modifiers) =>
                                    onAction('select', {
                                        changeId: commit.change_id,
                                        changeIdShortest: commit.change_id_shortest,
                                        isDivergent: commit.is_divergent,
                                        changeIdOffset: commit.change_id_offset,
                                        ...modifiers,
                                    })
                                }
                                onAction={onAction}
                                isSelected={isSelected}
                                selectionCount={selectedCommitIds?.size || 0}
                                hasImmutableSelection={hasImmutableSelection}
                                idDisplayLength={maxShortestIdLength}
                                hiddenActions={hiddenActions}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
