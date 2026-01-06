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

import React from 'react';
import { useDroppable, useDraggable, useDndContext } from '@dnd-kit/core';

import { IconButton } from './IconButton';
import { BookmarkPill, DraggableBookmark } from './Bookmark';

// Exported for DragOverlay in App.tsx
export { BookmarkPill } from './Bookmark';

// Shared payload for all actions
export interface ActionPayload {
    commitId: string;
    isImmutable?: boolean;
}

interface CommitNodeProps {
    commit: any;
    onClick: (modifiers: { multiSelect: boolean }) => void;
    onAction: (action: string, payload: ActionPayload) => void;
    isSelected?: boolean;
    selectionCount: number;
    hasImmutableSelection: boolean;
}

export const CommitNode: React.FC<CommitNodeProps> = ({
    commit,
    onClick,
    onAction,
    isSelected,
    selectionCount,
    hasImmutableSelection,
}) => {
    const isWorkingCopy = commit.is_working_copy;
    const isImmutable = commit.is_immutable;
    const isConflict = commit.conflict;
    const isEmpty = commit.is_empty;

    const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
        id: `commit-${commit.change_id}`,
        data: {
            type: 'commit',
            commitId: commit.change_id,
            description: commit.description, // Pass description for preview
            change_id_shortest: commit.change_id_shortest, // Pass short ID for preview styles
        },
    });

    const { setNodeRef: setDroppableRef, isOver } = useDroppable({
        id: `commit-${commit.change_id}`,
        data: { type: 'commit', commitId: commit.change_id },
    });
    const { active } = useDndContext();
    const [isHovered, setIsHovered] = React.useState(false);

    // Row styles
    let backgroundColor = undefined;
    let outline = undefined;

    // 1. Background Logic
    if (isSelected) {
        if (isConflict) {
            // Mix red conflict tint with blue selection tint
            backgroundColor =
                'color-mix(in srgb, var(--vscode-list-inactiveSelectionBackground), rgba(255, 0, 0, 0.2))';
        } else {
            backgroundColor = 'var(--vscode-list-inactiveSelectionBackground)';
        }
    } else if (isConflict) {
        backgroundColor = 'rgba(255, 0, 0, 0.1)';
    }

    // Allow hover background even while dragging (buttons hidden by JSX check)
    // Also use isOver to ensure background persists if mouse events are swallowed during drag
    if (isHovered || isOver) {
        if (isSelected) {
        } else if (isConflict) {
            backgroundColor = 'rgba(255, 0, 0, 0.2)';
        } else {
            backgroundColor = 'var(--vscode-list-hoverBackground)';
        }
    }

    // 2. Drop Logic (Additive)
    if (isOver) {
        const activeType = active?.data?.current?.type;
        // Only show row outline for commit drops (rebase).
        // Bookmarks show a specific ghost pill instead.
        if (activeType === 'commit') {
            // Use box-shadow 'inset' to create a border effect that renders reliably over backgrounds
            // Using list.activeSelectionForeground often ensures high contrast
            outline = '2px dashed var(--vscode-list-activeSelectionForeground)';
        }
    }

    // Text styles
    const textOpacity = isDragging ? 0.5 : 1;
    const fontStyle = isImmutable ? 'italic' : 'normal';

    const description = commit.description.split('\n')[0] || '(no description)';
    const displayDescription = isEmpty ? `(empty) ${description}` : description;

    // Merge refs for draggable and droppable
    // We need both on the same element
    const setCombinedRef = (node: HTMLElement | null) => {
        setNodeRef(node);
        setDroppableRef(node);
    };

    return (
        <div
            ref={setCombinedRef}
            {...listeners}
            {...attributes}
            className={`commit-row ${isWorkingCopy ? 'working-copy' : ''}`}
            data-vscode-context={JSON.stringify({
                webviewSection: 'commit',
                viewItem: isSelected ? 'jj-commit-selected' : 'jj-commit',
                commitId: commit.change_id,

                // Detailed Capabilities for Context Menu "when" clauses
                // Only show Abandon in context menu for multi-selection (use hover button for single)
                canAbandon: isSelected && selectionCount > 1 && !hasImmutableSelection,

                // Edit/NewBefore require mutable commits and currently single-item context
                canEdit: !isImmutable && (!isSelected || selectionCount <= 1),
                canNewBefore: !isImmutable && (!isSelected || selectionCount <= 1),

                // Duplicate works on any commit, but restricted to single-item context for now
                canDuplicate: !isSelected || selectionCount <= 1,

                // Rebase source must be mutable, and we rebase ONTO the current selection
                canRebaseOnto: !isImmutable && !isSelected && selectionCount > 0,

                // Merge requires multiple items selected
                canMerge: isSelected && selectionCount > 1,

                preventDefaultContextMenuItems: true,
            })}
            onClick={(e) => {
                const multiSelect = e.ctrlKey || e.metaKey;
                onClick({ multiSelect });
            }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            style={{
                height: '28px',
                display: 'flex',
                alignItems: 'center',
                fontFamily: 'var(--vscode-editor-font-family)',
                fontSize: 'var(--vscode-editor-font-size)',
                cursor: 'default',
                width: '100%', // Take remaining space
                backgroundColor: backgroundColor,
                outline: outline,
                outlineOffset: '-2px', // Pull outline inside
                // Disable touch action to prevent scrolling while dragging, if supported
                touchAction: 'none',
                minWidth: 0, // Allow shrinking
                paddingLeft: '6px', // Separation between highlight edge and content
            }}
        >
            <div
                className="commit-content"
                style={{ display: 'flex', alignItems: 'center', flex: 1, opacity: textOpacity, minWidth: 0 }}
            >
                <span
                    className="id-actions-area"
                    style={{
                        marginRight: '8px',
                        flexShrink: 0,
                        minWidth: '60px', // Reserve space for 8-char ID
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                    }}
                >
                    {/* Always render ID to maintain layout stability. */}
                    <span
                        className="commit-id"
                        style={{
                            color: isImmutable
                                ? 'var(--vscode-descriptionForeground)'
                                : 'var(--vscode-gitDecoration-addedResourceForeground)',
                            display: 'flex',
                            alignItems: 'center',
                            opacity: 1,
                        }}
                    >
                        {commit.change_id_shortest ? (
                            <>
                                <span style={{ fontWeight: 'bold' }}>{commit.change_id_shortest}</span>
                                <span style={{ opacity: 0.5 }}>
                                    {commit.change_id.substring(commit.change_id_shortest.length, 8)}
                                </span>
                            </>
                        ) : (
                            commit.change_id.substring(0, 8)
                        )}
                    </span>

                    {/* Overlay Actions */}
                    {isHovered && !active && !(selectionCount > 1) && (
                        <div
                            style={{
                                position: 'absolute',
                                left: '0',
                                top: '50%',
                                transform: 'translateY(-50%)',
                                display: 'flex',
                                alignItems: 'center',
                                // Use background shorthand for gradients
                                background: isSelected
                                    ? 'linear-gradient(var(--vscode-list-inactiveSelectionBackground), var(--vscode-list-inactiveSelectionBackground)), var(--vscode-sideBar-background)'
                                    : isConflict
                                      ? 'linear-gradient(rgba(255, 0, 0, 0.2), rgba(255, 0, 0, 0.2)), var(--vscode-sideBar-background)'
                                      : 'linear-gradient(var(--vscode-list-hoverBackground), var(--vscode-list-hoverBackground)), var(--vscode-sideBar-background)',
                                paddingRight: '20px',
                                maskImage: 'linear-gradient(to right, black 60%, transparent 100%)',
                                WebkitMaskImage: 'linear-gradient(to right, black 60%, transparent 100%)',
                                zIndex: 1,
                                height: '100%',
                                paddingLeft: '0',
                            }}
                        >
                            <IconButton
                                title="New Child"
                                icon="codicon-plus"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onAction('newChild', { commitId: commit.change_id });
                                }}
                            />

                            {commit.parents_immutable &&
                                commit.parents_immutable.length === 1 &&
                                !commit.parents_immutable[0] && (
                                    <IconButton
                                        title="Move to Parent (Squash)"
                                        icon="codicon-arrow-down"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onAction('squash', { commitId: commit.change_id });
                                        }}
                                    />
                                )}

                            {!isImmutable && (
                                <IconButton
                                    title="Abandon"
                                    icon="codicon-trash"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onAction('abandon', { commitId: commit.change_id });
                                    }}
                                />
                            )}
                        </div>
                    )}
                </span>

                <span
                    className="commit-desc"
                    style={{
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        fontWeight: isWorkingCopy ? 'bold' : 'normal',
                        color: isImmutable
                            ? 'var(--vscode-descriptionForeground)'
                            : isEmpty
                              ? 'var(--vscode-testing-iconPassed)'
                              : !commit.description
                                ? 'var(--vscode-editorWarning-foreground)'
                                : 'inherit',
                        fontStyle: fontStyle,
                        marginRight: '8px',
                        flex: 1, // Allow description to take available space
                    }}
                >
                    {displayDescription}
                </span>

                {/* Right-aligned Bookmarks */}
                <span style={{ display: 'flex', marginLeft: 'auto', flexShrink: 0, gap: '4px' }}>
                    {commit.bookmarks &&
                        commit.bookmarks.map((bookmark: any) => (
                            <DraggableBookmark
                                key={`${bookmark.name}-${bookmark.remote || 'local'}`}
                                bookmark={bookmark}
                            />
                        ))}

                    {isOver &&
                        active?.data?.current?.type === 'bookmark' &&
                        !commit.bookmarks?.some(
                            (b: any) =>
                                b.name === active.data.current?.name && b.remote === active.data.current?.remote,
                        ) && (
                            <BookmarkPill
                                bookmark={{ name: active.data.current?.name, remote: active.data.current?.remote }}
                                style={{
                                    opacity: 0.7,
                                    backgroundColor: 'transparent',
                                    border: '1px dashed var(--vscode-charts-blue)',
                                    boxShadow: 'inset 0 0 8px var(--vscode-charts-blue)',
                                }}
                            />
                        )}
                </span>
            </div>
        </div>
    );
};
