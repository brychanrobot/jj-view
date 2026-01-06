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

    // Width of a lane in pixels
    const LANE_WIDTH = 16;
    const ROW_HEIGHT = 28;

    // Total graph width calculation
    const LEFT_MARGIN = 12; // Match GraphRail
    const GAP = 10; // Space between graph and text

    // Padding-left for the text area
    const graphAreaWidth = layout.width * LANE_WIDTH + LEFT_MARGIN + GAP;

    return (
        <div className="commit-graph" style={{ position: 'relative', fontFamily: 'codicon' }}>
            {/* SVG Graph Overlay */}
            <GraphRail
                nodes={layout.nodes}
                edges={layout.edges}
                width={layout.width}
                height={layout.height}
                selectedNodes={selectedCommitIds}
            />

            {/* Commit List (Text) */}
            <div style={{ position: 'relative', zIndex: 1 }}>
                {(layout.rows || commits).map((commit) => {
                    const isSelected = selectedCommitIds?.has(commit.change_id);
                    const hasImmutableSelection =
                        selectedCommitIds && selectedCommitIds.size > 0
                            ? (layout.rows || commits).some((c) => selectedCommitIds.has(c.change_id) && c.is_immutable)
                            : false;

                    return (
                        <div
                            key={commit.commit_id}
                            style={{
                                height: ROW_HEIGHT,
                                paddingLeft: graphAreaWidth,
                                display: 'flex',
                                alignItems: 'center',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
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
