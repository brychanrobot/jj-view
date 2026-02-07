/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, useSensor, useSensors, pointerWithin } from '@dnd-kit/core';
import { CommitGraph } from './components/CommitGraph';

// Define the vscode API from the global scope (see global.d.ts)
const vscode = window.acquireVsCodeApi();

import { CommitDetails } from './components/CommitDetails';
import { BookmarkPill } from './components/Bookmark';
import { CommitDragPreview } from './components/CommitDragPreview';
import { snapToCursorLeft } from './utils/modifiers';
import { calculateNextSelection, hasImmutableSelection } from './utils/selection-utils';

const App: React.FC = () => {
    // Initial State from Window (injected by provider)
    const initialData = window.vscodeInitialData;
    const initialView = initialData?.view || 'graph';

    const [view] = React.useState<'graph' | 'details'>(initialView);
    const [commits, setCommits] = React.useState<any[]>([]);
    // Use ref to access latest commits in event listeners without triggering re-effects
    const commitsRef = React.useRef(commits);
    React.useEffect(() => {
        commitsRef.current = commits;
    }, [commits]);

    const [loading, setLoading] = React.useState(initialView === 'graph'); // Only load graph if in graph mode
    const [selectedCommitIds, setSelectedCommitIds] = React.useState<Set<string>>(new Set());

    // Details State
    const [detailsCommit] = React.useState<any>(initialData?.payload || null);

    // Drag State
    const [activeDragItem, setActiveDragItem] = React.useState<any | null>(null);
    const [isCtrlPressed, setIsCtrlPressed] = React.useState(false);

    // Configure sensors with activation constraint to prevent accidental drags on click
    const sensors = useSensors(
        useSensor(MouseSensor, {
            activationConstraint: {
                distance: 5,
            },
        }),
        useSensor(TouchSensor, {
            activationConstraint: {
                delay: 250,
                tolerance: 5,
            },
        }),
    );

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Control' || e.key === 'Meta') setIsCtrlPressed(true);

            // Escape to deselect
            if (e.key === 'Escape') {
                setSelectedCommitIds(new Set());
                vscode.postMessage({
                    type: 'selectionChange',
                    payload: {
                        commitIds: [],
                        hasImmutableSelection: false,
                    },
                });
            }
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Control' || e.key === 'Meta') setIsCtrlPressed(false);
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
    }, []);

    React.useEffect(() => {
        // Listen for messages from the extension
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            switch (message.type) {
                case 'update':
                    if (view === 'graph') {
                        setCommits(message.commits);
                        setLoading(false);
                    }
                    break;
                case 'updateDetails':
                    // If we get an update while in details view (e.g. after save)
                    if (view === 'details') {
                        // Optional: update local state if needed via message
                    }
                    break;
                case 'setSelection':
                    // External request to set selection (e.g. from closing details tab)
                    const newIds = new Set<string>(message.ids || []);
                    setSelectedCommitIds(newIds);
                    // Calculate immutability status for the new selection
                    const hasImmutable = hasImmutableSelection(newIds, commitsRef.current);

                    vscode.postMessage({
                        type: 'selectionChange',
                        payload: {
                            commitIds: Array.from(newIds),
                            hasImmutableSelection: hasImmutable,
                        },
                    });
                    break;
            }
        };

        window.addEventListener('message', handleMessage);

        // Signal that we are ready
        vscode.postMessage({ type: 'webviewLoaded' });

        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, [view]);

    const handleGraphAction = (action: string, payload: any) => {
        if (action === 'select') {
            const { commitId, multiSelect } = payload;

            // 1. Calculate new selection state
            const nextSelectedIds = calculateNextSelection(selectedCommitIds, commitId, multiSelect);

            // 2. Update visual selection state
            setSelectedCommitIds(nextSelectedIds);

            // 3. Notify Extension of Selection Change
            const hasImmutable = hasImmutableSelection(nextSelectedIds, commits);

            vscode.postMessage({
                type: 'selectionChange',
                payload: {
                    commitIds: Array.from(nextSelectedIds),
                    hasImmutableSelection: hasImmutable,
                },
            });

            // 4. Request Details ONLY if the item ends up selected
            // (If we toggled it off, we shouldn't open details)
            if (nextSelectedIds.has(commitId)) {
                vscode.postMessage({ type: 'getDetails', payload });
            }
            return;
        }

        if (action === 'contextMenu') {
            // Include current selection in payload for smarter menus
            vscode.postMessage({
                type: action,
                payload: {
                    ...payload,
                    selectedCommitIds: Array.from(selectedCommitIds),
                },
            });
            return;
        }

        vscode.postMessage({ type: action, payload });
    };

    const handleSaveDescription = (description: string) => {
        if (view === 'details' && detailsCommit) {
            vscode.postMessage({
                type: 'saveDescription',
                payload: { commitId: detailsCommit.commitId, description },
            });
        }
    };

    const handleOpenDiff = (filePath: string) => {
        if (view === 'details' && detailsCommit) {
            vscode.postMessage({
                type: 'openDiff',
                payload: { commitId: detailsCommit.commitId, filePath },
            });
        }
    };

    const handleDragStart = (event: any) => {
        setActiveDragItem(event.active.data.current);
    };

    const handleDragEnd = (event: any) => {
        const { active, over } = event;
        setActiveDragItem(null);

        if (!over || active.id === over.id) {
            return;
        }

        const activeType = active.data.current?.type;

        if (activeType === 'bookmark') {
            // bookmark-NAME -> NAME
            const bookmarkName = active.data.current.name;
            const bookmarkRemote = active.data.current.remote;
            // commit-ID -> ID
            const targetCommitId = over.data.current.commitId;

            // Optimistic Update
            setCommits((prevCommits) => {
                // Check if move is actually needed (and find source)
                const sourceCommit = prevCommits.find((c) =>
                    c.bookmarks?.some((b: any) => b.name === bookmarkName && b.remote === bookmarkRemote),
                );

                if (!sourceCommit || sourceCommit.change_id === targetCommitId) {
                    return prevCommits;
                }

                return prevCommits.map((commit) => {
                    let newBookmarks = commit.bookmarks || [];

                    // Remove from source
                    if (newBookmarks.some((b: any) => b.name === bookmarkName && b.remote === bookmarkRemote)) {
                        newBookmarks = newBookmarks.filter(
                            (b: any) => !(b.name === bookmarkName && b.remote === bookmarkRemote),
                        );
                    }

                    // Add to target
                    if (commit.change_id === targetCommitId) {
                        newBookmarks = [...newBookmarks, { name: bookmarkName, remote: bookmarkRemote }];
                    }

                    // Return new object if changed
                    if (newBookmarks !== commit.bookmarks) {
                        const updated = { ...commit, bookmarks: newBookmarks };
                        return updated;
                    }
                    return commit;
                });
            });

            // Send to extension
            vscode.postMessage({
                type: 'moveBookmark',
                payload: { bookmark: bookmarkName, targetCommitId },
            });
        } else if (activeType === 'commit') {
            const sourceCommitId = active.data.current.commitId;
            const targetCommitId = over.data.current.commitId;

            // Detect modifier keys from the activator event or our state
            // Prefer tracking state for consistency with UI
            const mode = isCtrlPressed ? 'revision' : 'source';

            vscode.postMessage({
                type: 'rebaseCommit',
                payload: { sourceCommitId, targetCommitId, mode },
            });
        }
    };

    // Render
    if (view === 'details' && detailsCommit) {
        return (
            <CommitDetails
                commitId={detailsCommit.commitId}
                description={detailsCommit.description}
                files={detailsCommit.files}
                onSave={handleSaveDescription}
                onOpenDiff={handleOpenDiff}
            />
        );
    }

    if (loading) {
        return <div style={{ padding: '20px', color: 'var(--vscode-descriptionForeground)' }}>Loading changes...</div>;
    }

    return (
        <div className="app-container">
            <DndContext
                sensors={sensors}
                collisionDetection={pointerWithin}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
            >
                <div
                    style={{ flex: 1, overflow: 'auto', minHeight: '100vh' }}
                    onClick={(e) => {
                        // Only clear if clicking the container itself, not children
                        if (e.target === e.currentTarget) {
                            setSelectedCommitIds(new Set());
                            vscode.postMessage({
                                type: 'selectionChange',
                                payload: {
                                    commitIds: [],
                                    hasImmutableSelection: false,
                                },
                            });
                        }
                    }}
                >
                    <CommitGraph commits={commits} onAction={handleGraphAction} selectedCommitIds={selectedCommitIds} />
                </div>
                {/* 
                  snapCenterToCursor ensures the preview is always centered on the mouse, 
                  regardless of where the user grabbed the original wide row.
                */}
                <DragOverlay
                    dropAnimation={null}
                    modifiers={activeDragItem?.type === 'commit' ? [snapToCursorLeft] : undefined}
                >
                    {activeDragItem ? (
                        activeDragItem.type === 'bookmark' ? (
                            <BookmarkPill
                                bookmark={{ name: activeDragItem.name, remote: activeDragItem.remote }}
                                style={{
                                    cursor: 'grabbing',
                                    opacity: 1,
                                    boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
                                }}
                            />
                        ) : activeDragItem.type === 'commit' ? (
                            <CommitDragPreview commit={activeDragItem} isCtrlPressed={isCtrlPressed} />
                        ) : null
                    ) : null}
                </DragOverlay>
            </DndContext>
        </div>
    );
};

export default App;
