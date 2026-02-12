/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useDroppable, useDraggable, useDndContext } from '@dnd-kit/core';

import { IconButton } from './IconButton';
import { BookmarkPill, DraggableBookmark } from './Bookmark';
import { GerritClInfo } from '../../jj-types'; // Import GerritClInfo (needs to be available in types or duplicated)

// Exported for DragOverlay in App.tsx
export { BookmarkPill } from './Bookmark';

// Shared payload for all actions
export interface ActionPayload {
    commitId: string;
    isImmutable?: boolean;
    url?: string;
}

interface CommitNodeProps {
    commit: any;
    onClick: (modifiers: { multiSelect: boolean }) => void;
    onAction: (action: string, payload: ActionPayload) => void;
    isSelected?: boolean;
    selectionCount: number;
    hasImmutableSelection: boolean;
    idDisplayLength?: number;
}

export const CommitNode: React.FC<CommitNodeProps> = ({
    commit,
    onClick,
    onAction,
    isSelected,
    selectionCount,
    hasImmutableSelection,
    idDisplayLength = 8, // Default fallback
}) => {
    const isWorkingCopy = commit.is_working_copy;
    const isImmutable = commit.is_immutable;
    const isConflict = commit.conflict;
    const isEmpty = commit.is_empty;
    const gerritCl = commit.gerritCl as GerritClInfo | undefined;

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

                // Absorb requires at least one mutable parent and single-item context
                canAbsorb: commit.parents_immutable?.some((immutable: boolean) => !immutable) && (!isSelected || selectionCount <= 1),

                preventDefaultContextMenuItems: true,
            })}
            onClick={(e) => {
                const multiSelect = e.ctrlKey || e.metaKey;
                onClick({ multiSelect });
            }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            style={{
                minHeight: '28px',
                height: 'auto',
                display: 'flex',
                alignItems: 'stretch',
                flexDirection: 'row',
                justifyContent: 'flex-start',
                paddingBottom: '0',
                cursor: 'default',
                width: '100%',
                backgroundColor: backgroundColor,
                outline: outline,
                outlineOffset: '-2px',
                touchAction: 'none',
                minWidth: 0,
                paddingLeft: '6px',
                paddingTop: '0',
            }}
        >
            {/* Left Column: ID and Actions */}
            <span
                className="id-actions-area"
                style={{
                    marginRight: '8px',
                    flexShrink: 0,
                    width: `${idDisplayLength}ch`,
                    minWidth: `${idDisplayLength}ch`,
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    height: '28px',
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
                        fontFamily: 'monospace', // Ensure ch units align with text
                    }}
                >
                    {commit.change_id_shortest ? (
                        <>
                            <span style={{ fontWeight: 'bold' }}>{commit.change_id_shortest}</span>
                            <span style={{ opacity: 0.5 }}>
                                {commit.change_id.substring(commit.change_id_shortest.length, idDisplayLength)}
                            </span>
                        </>
                    ) : (
                        commit.change_id.substring(0, idDisplayLength)
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

            {/* Right Column: Description, Bookmarks, Gerrit Info */}
            <div
                style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 0,
                    justifyContent: 'center',
                }}
            >
                {/* Description & Bookmarks */}
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        height: '28px',
                        lineHeight: '28px',
                        width: '100%',
                    }}
                >
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
                            flex: 1,
                            minWidth: 0, // Critical for text-overflow in flex children
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

                {/* Gerrit Info */}
                {gerritCl && (
                    <div
                        className="gerrit-row"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            marginTop: '-6px',
                            opacity: textOpacity,
                            overflow: 'hidden',
                            height: '22px', 
                        }}
                    >
                        {/* Status Badge */}
                        {(gerritCl.status === 'MERGED' || gerritCl.status === 'ABANDONED') && (
                            <span
                                style={{
                                    border: '1px solid',
                                    borderColor:
                                        gerritCl.status === 'MERGED'
                                            ? 'var(--vscode-descriptionForeground)'
                                            : 'var(--vscode-gitDecoration-ignoredResourceForeground)',
                                    color:
                                        gerritCl.status === 'MERGED'
                                            ? 'var(--vscode-descriptionForeground)'
                                            : 'var(--vscode-gitDecoration-ignoredResourceForeground)',
                                    backgroundColor: 'transparent',
                                    padding: '0px 4px',
                                    borderRadius: '3px',
                                    fontWeight: 'normal',
                                    fontSize: 'inherit',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    opacity: 0.9,
                                    height: '16px',
                                    lineHeight: '14px',
                                }}
                            >
                                {gerritCl.status}
                            </span>
                        )}

                        {/* CL Link */}
                        <a
                            href={gerritCl.url}
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onAction('openGerrit', {
                                    commitId: commit.change_id,
                                    url: gerritCl.url,
                                });
                            }}
                            style={{
                                color: 'var(--vscode-textLink-foreground)',
                                textDecoration: 'none',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '3px',
                            }}
                            title={gerritCl.url}
                        >
                            <span>CL/{gerritCl.changeNumber}</span>
                            <span className="codicon codicon-link-external" style={{ fontSize: '10px' }} />
                        </a>

                        {/* Sync Status Button or Icon */}
                        {gerritCl.status === 'NEW' &&
                            (gerritCl.currentRevision === commit.commit_id ? (
                                // Synced - Non-interactive Icon
                                <div
                                    title="Up to date with Gerrit"
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        marginLeft: '4px',
                                        color: 'var(--vscode-descriptionForeground)',
                                        cursor: 'default',
                                    }}
                                >
                                    <span
                                        className="codicon codicon-cloud"
                                        style={{ fontSize: '14px' }}
                                    />
                                </div>
                            ) : (
                                // Not Synced - Interactive Upload Button
                                <div
                                    role="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onAction('upload', { commitId: commit.change_id });
                                    }}
                                    title="Local changes need upload (Click to push)"
                                    style={{
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        marginLeft: '4px',
                                        color: 'var(--vscode-charts-yellow)',
                                    }}
                                >
                                    <span
                                        className="codicon codicon-cloud-upload"
                                        style={{ fontSize: '14px' }}
                                    />
                                </div>
                            ))}

                        {/* Attributes */}
                        {gerritCl.unresolvedComments > 0 && (
                            <span 
                                title={`${gerritCl.unresolvedComments} Unresolved Comments`}
                                style={{ 
                                    display: 'flex', 
                                    alignItems: 'center', 
                                    gap: '3px', 
                                    color: 'var(--vscode-problemsWarningIcon-foreground)',
                                    marginLeft: '4px'
                                }}
                            >
                                <span className="codicon codicon-comment-discussion" style={{ fontSize: '11px' }} />
                                <span>{gerritCl.unresolvedComments}</span>
                            </span>
                        )}

                        {gerritCl.submittable && gerritCl.status === 'NEW' && (
                            <span 
                                title="Ready to Submit"
                                style={{ 
                                    display: 'flex', 
                                    alignItems: 'center', 
                                    color: 'var(--vscode-testing-iconPassed)',
                                    marginLeft: '4px'
                                }}
                            >
                                <span className="codicon codicon-check" style={{ fontSize: '12px' }} />
                            </span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
