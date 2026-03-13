/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import { getChangeIdDisplayLength, shortenChangeId } from '../../utils/jj-utils';

export const CommitDragPreview: React.FC<{
    commit: any; // Simplified commit object or drag data
    isCtrlPressed: boolean;
    minChangeIdLength: number;
}> = ({ commit, isCtrlPressed, minChangeIdLength }) => {
    // Mode Logic
    const mode = isCtrlPressed ? 'revision' : 'source';
    const isRevisionMode = mode === 'revision';

    // Theme Colors
    const branchColor = 'var(--vscode-charts-blue)';
    const revisionColor = 'var(--vscode-charts-orange)';
    const activeColor = isRevisionMode ? revisionColor : branchColor;

    // ID Formatting
    const fullId = commit.commitId || '';
    const idDisplayLength = getChangeIdDisplayLength(commit.change_id_shortest, minChangeIdLength);
    const shortId = commit.change_id_shortest || shortenChangeId(fullId, idDisplayLength);
    const remainderId = fullId.substring(shortId.length, idDisplayLength);

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'row',
                backgroundColor: 'var(--vscode-editor-background)',
                border: `1px solid var(--vscode-focusBorder)`, // Solid border
                borderRadius: '4px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                width: '280px', // Fixed manageable width
                height: '50px', // Compact height
                overflow: 'hidden',
                fontFamily: 'var(--vscode-editor-font-family)',
                fontSize: 'var(--vscode-editor-font-size)',
                // Optimization: Remove transitions to prevent fighting with dnd-kit
                transition: 'none',
                // Optimization: Promote to layer
                willChange: 'transform',
                // Optimization: Don't block mouse events so we can detect what's underneath
                pointerEvents: 'none',
            }}
        >
            {/* Left Handle */}
            <div
                style={{
                    width: '6px',
                    backgroundColor: activeColor,
                    height: '100%',
                    flexShrink: 0,
                }}
            />

            {/* Content Area */}
            <div
                style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    padding: '0 10px',
                    minWidth: 0, // Enable truncation
                }}
            >
                {/* Row 1: Description (Primary) */}
                <div
                    style={{
                        fontWeight: 'bold',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        marginBottom: '2px',
                        color: 'var(--vscode-foreground)',
                    }}
                >
                    {commit.description || '(no description)'}
                </div>

                {/* Row 2: ID + Status (Secondary) */}
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        fontSize: '0.9em',
                        color: 'var(--vscode-descriptionForeground)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                    }}
                >
                    {/* ID */}
                    <span
                        style={{
                            fontFamily: 'var(--vscode-editor-font-family)',
                            marginRight: '8px',
                            display: 'flex',
                        }}
                    >
                        <span
                            style={{ color: 'var(--vscode-gitDecoration-addedResourceForeground)', fontWeight: 'bold' }}
                        >
                            {shortId}
                        </span>
                        <span style={{ opacity: 0.7 }}>{remainderId}</span>
                    </span>

                    {/* Separator */}
                    <span style={{ marginRight: '8px', opacity: 0.5 }}>•</span>

                    {/* Combined Status Text */}
                    <span
                        style={{
                            color: activeColor,
                            fontWeight: 500,
                            display: 'flex',
                            alignItems: 'center',
                        }}
                    >
                        {isRevisionMode ? 'Rebase revision only' : 'Rebase branch (Ctrl for rev)'}
                    </span>
                </div>
            </div>
        </div>
    );
};
