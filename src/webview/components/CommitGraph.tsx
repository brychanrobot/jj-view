/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import { computeGraphLayout } from '../graph-compute';
import { GraphRail } from './GraphRail';
import { CommitNode, ActionPayload } from './CommitNode';

interface CommitGraphProps {
    commits: any[];
    onAction: (action: string, payload: ActionPayload) => void;
    selectedCommitIds?: Set<string>;
}

export const CommitGraph: React.FC<CommitGraphProps> = ({ commits, onAction, selectedCommitIds }) => {
    const layout = React.useMemo(() => computeGraphLayout(commits), [commits]);
    const displayRows = layout.rows || commits;

    // Width of a lane in pixels
    const LANE_WIDTH = 16;
    const ROW_HEIGHT_NORMAL = 28;
    const ROW_HEIGHT_EXPANDED = 44; // Reduced to 44px (28 top - 6 overlap + 22 bottom)

    // Calculate Row Offsets
    // This allows us to have variable height rows while keeping the graph aligned.
    const { rowOffsets, totalHeight } = React.useMemo(() => {
        let currentOffset = 0;
        const offsets: number[] = [];
        
        displayRows.forEach(commit => {
            offsets.push(currentOffset);
            // Height logic matching the renderer in CommitNode
            const height = commit.gerritCl ? ROW_HEIGHT_EXPANDED : ROW_HEIGHT_NORMAL;
            currentOffset += height;
        });
        
        // Push one last offset for the total height boundary (useful for empty space calculations if needed)
        offsets.push(currentOffset);

        return { rowOffsets: offsets, totalHeight: currentOffset };
    }, [displayRows]);


    // Total graph width calculation
    const LEFT_MARGIN = 12; // Match GraphRail
    const GAP = 10; // Space between graph and text

    // Padding-left for the text area
    const graphAreaWidth = layout.width * LANE_WIDTH + LEFT_MARGIN + GAP;

    return (
        <div className="commit-graph" style={{ position: 'relative' }}>
            {/* SVG Graph Overlay */}
            <GraphRail
                nodes={layout.nodes}
                edges={layout.edges}
                width={layout.width}
                height={totalHeight}
                rowOffsets={rowOffsets}
                selectedNodes={selectedCommitIds}
            />

            {/* Commit List (Text) */}
            <div style={{ position: 'relative', zIndex: 1 }}>
                {displayRows.map((commit) => {
                    const isSelected = selectedCommitIds?.has(commit.change_id);
                    const hasImmutableSelection =
                        selectedCommitIds && selectedCommitIds.size > 0
                            ? displayRows.some((c) => selectedCommitIds.has(c.change_id) && c.is_immutable)
                            : false;

                    const height = commit.gerritCl ? ROW_HEIGHT_EXPANDED : ROW_HEIGHT_NORMAL;

                    return (
                        <div
                            key={commit.commit_id}
                            style={{
                                height: height,
                                paddingLeft: graphAreaWidth,
                                display: 'flex',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                alignItems: 'flex-start', // Align with top primary row
                            }}
                        >
                            <CommitNode
                                commit={commit}
                                onClick={(modifiers) =>
                                    onAction('select', { commitId: commit.change_id, ...modifiers })
                                }
                                onAction={onAction}
                                isSelected={isSelected}
                                selectionCount={selectedCommitIds?.size || 0}
                                hasImmutableSelection={hasImmutableSelection}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
