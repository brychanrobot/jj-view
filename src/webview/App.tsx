/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
    DndContext,
    type DragEndEvent,
    DragOverlay,
    type DragStartEvent,
    MouseSensor,
    pointerWithin,
    TouchSensor,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import * as React from 'react';
import type {
    ActionPayload,
    CommitAction,
    JjLogEntry,
    JjStatusEntry,
    WebviewInitialData,
    WebviewPayload,
} from '../jj-types';
import { BookmarkPill } from './components/Bookmark';
import { CommitDetails } from './components/CommitDetails';
import { CommitDragPreview } from './components/CommitDragPreview';
import { CommitGraph } from './components/CommitGraph';
import { useDragModifiers } from './hooks/useDragModifiers';
import { useBridge } from './transport/BridgeContext';
import { snapToCursorLeft } from './utils/modifiers';
import { calculateNextSelection, hasImmutableSelection } from './utils/selection-utils';

type DragItem =
    | { type: 'bookmark'; name: string; remote?: string }
    | (JjLogEntry & { type: 'commit'; changeId: string });

const App: React.FC = () => {
    const bridge = useBridge();
    // Initial State from Bridge
    const initialData = bridge.getInitialData<WebviewInitialData>();
    const initialView = initialData?.view || 'graph';

    const [view] = React.useState<'graph' | 'details'>(initialView);
    const [commits, setCommits] = React.useState<JjLogEntry[]>(initialData?.payload?.commits || []);
    const [minChangeIdLength, setMinChangeIdLength] = React.useState<number>(
        initialData?.payload?.minChangeIdLength || 1,
    );
    const [theme, setTheme] = React.useState<string>(initialData?.payload?.theme || 'default');
    const [graphLabelAlignment, setGraphLabelAlignment] = React.useState<string>(
        initialData?.payload?.graphLabelAlignment || 'aligned',
    );
    // Use refs to access latest state in event listeners without triggering re-effects
    const commitsRef = React.useRef(commits);
    React.useEffect(() => {
        commitsRef.current = commits;
    }, [commits]);

    const viewRef = React.useRef(view);
    React.useEffect(() => {
        viewRef.current = view;
    }, [view]);

    const [loading, setLoading] = React.useState(
        initialView === 'graph' && !(initialData?.payload?.commits && initialData.payload.commits.length > 0),
    ); // Only load graph if in graph mode and no initial commits
    const [selectedCommitIds, setSelectedCommitIds] = React.useState<Set<string>>(new Set());
    const [hiddenActions, setHiddenActions] = React.useState<Set<CommitAction>>(
        new Set(initialData?.payload?.hiddenActions || []),
    );

    // Details State
    const [detailsCommit, setDetailsCommit] = React.useState<WebviewPayload | null>(initialData?.payload || null);

    // Drag State
    const [activeDragItem, setActiveDragItem] = React.useState<DragItem | null>(null);
    const { activeModifier, resetKeys } = useDragModifiers();

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
            // Escape to deselect
            if (e.key === 'Escape') {
                setSelectedCommitIds(new Set());
                bridge.postMessage({
                    type: 'selectionChange',
                    payload: {
                        commitIds: [],
                        hasImmutableSelection: false,
                    },
                });
            }
        };

        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [bridge]);

    React.useEffect(() => {
        // Listen for messages from the host
        const handleMessage = (rawMessage: unknown) => {
            if (!rawMessage || typeof rawMessage !== 'object' || !('type' in rawMessage)) {
                return;
            }
            const message = rawMessage as {
                type: string;
                commits?: JjLogEntry[];
                minChangeIdLength?: number;
                theme?: string;
                graphLabelAlignment?: string;
                hiddenActions?: CommitAction[];
                payload?: { changeId?: string; description?: string; hiddenActions?: CommitAction[] } & WebviewPayload;
                ids?: string[];
            };
            switch (message.type) {
                case 'update':
                    if (viewRef.current === 'graph' && message.commits) {
                        const newCommits = message.commits;
                        setCommits(newCommits);
                        if (message.minChangeIdLength !== undefined) {
                            setMinChangeIdLength(message.minChangeIdLength);
                        }
                        if (message.theme !== undefined) {
                            setTheme(message.theme);
                        }
                        if (message.graphLabelAlignment !== undefined) {
                            setGraphLabelAlignment(message.graphLabelAlignment);
                        }
                        if (message.hiddenActions !== undefined) {
                            setHiddenActions(new Set(message.hiddenActions));
                        }
                        setLoading(false);

                        // Validate current selection against new commits list
                        setSelectedCommitIds((prevIds) => {
                            if (prevIds.size === 0) {
                                return prevIds;
                            }

                            const validIds = Array.from(prevIds).filter((id) =>
                                newCommits.some((c: JjLogEntry) => c.change_id === id),
                            );

                            if (validIds.length !== prevIds.size) {
                                const newIds = new Set(validIds);
                                const hasImmutable = hasImmutableSelection(newIds, newCommits);

                                bridge.postMessage({
                                    type: 'selectionChange',
                                    payload: {
                                        commitIds: validIds,
                                        hasImmutableSelection: hasImmutable,
                                    },
                                });
                                return newIds;
                            }
                            return prevIds;
                        });
                    }
                    break;
                case 'updateDetails':
                    // If we get an update while in details view (e.g. after save)
                    if (viewRef.current === 'details') {
                        setDetailsCommit(message.payload ?? null);
                    }
                    break;
                case 'saveComplete':
                    if (viewRef.current === 'details' && message.payload?.description !== undefined) {
                        const newDesc = message.payload.description;
                        setDetailsCommit((prev) => (prev ? { ...prev, description: newDesc } : prev));
                    }
                    break;
                case 'setSelection': {
                    // External request to set selection (e.g. from closing details tab)
                    const newIds = new Set<string>(message.ids || []);
                    setSelectedCommitIds(newIds);
                    // Calculate immutability status for the new selection
                    const hasImmutable = hasImmutableSelection(newIds, commitsRef.current);

                    bridge.postMessage({
                        type: 'selectionChange',
                        payload: {
                            commitIds: Array.from(newIds),
                            hasImmutableSelection: hasImmutable,
                        },
                    });
                    break;
                }
                case 'panelClosed':
                    setSelectedCommitIds((prevIds) => {
                        if (message.payload?.changeId && prevIds.has(message.payload.changeId) && prevIds.size === 1) {
                            const clearedIds = new Set<string>();
                            bridge.postMessage({
                                type: 'selectionChange',
                                payload: {
                                    commitIds: [],
                                    hasImmutableSelection: false,
                                },
                            });
                            return clearedIds;
                        }
                        return prevIds;
                    });
                    break;
                case 'updateHiddenActions':
                    if (message.payload?.hiddenActions) {
                        setHiddenActions(new Set(message.payload.hiddenActions));
                    }
                    break;
            }
        };

        const unsubscribe = bridge.onMessage(handleMessage);

        // Signal that we are ready
        bridge.postMessage({ type: 'webviewLoaded' });

        return () => {
            unsubscribe();
        };
    }, [bridge]);

    const handleGraphAction = (action: string, payload: ActionPayload) => {
        if (action === 'select') {
            const { changeId, multiSelect } = payload;

            // 1. Calculate new selection state
            const nextSelectedIds = calculateNextSelection(selectedCommitIds, changeId, !!multiSelect);

            // 2. Update visual selection state
            setSelectedCommitIds(nextSelectedIds);

            // 3. Notify Host of Selection Change
            const hasImmutable = hasImmutableSelection(nextSelectedIds, commits);

            bridge.postMessage({
                type: 'selectionChange',
                payload: {
                    commitIds: Array.from(nextSelectedIds),
                    hasImmutableSelection: hasImmutable,
                },
            });

            // 4. Request Details ONLY if the item ends up selected
            // (If we toggled it off, we shouldn't open details)
            if (nextSelectedIds.has(changeId)) {
                bridge.postMessage({ type: 'getDetails', payload });
            }
            return;
        }

        if (action === 'showComments') {
            bridge.postMessage({ type: 'showComments', payload });
            return;
        }

        if (action === 'contextMenu') {
            // Include current selection in payload for smarter menus
            bridge.postMessage({
                type: action,
                payload: {
                    ...payload,
                    selectedCommitIds: Array.from(selectedCommitIds),
                },
            });
            return;
        }

        bridge.postMessage({ type: action, payload });
    };

    const handleSaveDescription = (description: string) => {
        if (view === 'details' && detailsCommit) {
            bridge.postMessage({
                type: 'saveDescription',
                payload: { changeId: detailsCommit.changeId, description },
            });
        }
    };

    const handleOpenDiff = (file: JjStatusEntry, isImmutable: boolean) => {
        if (view === 'details' && detailsCommit) {
            bridge.postMessage({
                type: 'openDiff',
                payload: { changeId: detailsCommit.changeId, file, isImmutable },
            });
        }
    };

    const handleOpenMultiDiff = () => {
        if (view === 'details' && detailsCommit) {
            bridge.postMessage({
                type: 'openMultiDiff',
                payload: { changeId: detailsCommit.changeId },
            });
        }
    };

    const handleDragStart = (event: DragStartEvent) => {
        setActiveDragItem(event.active.data.current as DragItem);
    };

    const handleDragCancel = () => {
        setActiveDragItem(null);
        resetKeys();
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveDragItem(null);

        try {
            if (!over || active.id === over.id || !active.data.current || !over.data.current) {
                return;
            }

            const activeType = (active.data.current as DragItem).type;

            if (activeType === 'bookmark') {
                // bookmark-NAME -> NAME
                const bookmarkName = (active.data.current as DragItem & { type: 'bookmark' }).name;
                const bookmarkRemote = (active.data.current as DragItem & { type: 'bookmark' }).remote;
                // commit-ID -> ID
                const targetChangeId = over.data.current.changeId;

                // Optimistic Update
                setCommits((prevCommits) => {
                    // Check if move is actually needed (and find source)
                    const sourceCommit = prevCommits.find((c) =>
                        c.bookmarks?.some((b) => b.name === bookmarkName && b.remote === bookmarkRemote),
                    );

                    if (!sourceCommit || sourceCommit.change_id === targetChangeId) {
                        return prevCommits;
                    }

                    return prevCommits.map((commit) => {
                        let newBookmarks = commit.bookmarks || [];

                        // Remove from source
                        if (newBookmarks.some((b) => b.name === bookmarkName && b.remote === bookmarkRemote)) {
                            newBookmarks = newBookmarks.filter(
                                (b) => !(b.name === bookmarkName && b.remote === bookmarkRemote),
                            );
                        }

                        // Add to target
                        if (commit.change_id === targetChangeId) {
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

                // Send to host
                bridge.postMessage({
                    type: 'moveBookmark',
                    payload: { bookmark: bookmarkName, targetChangeId },
                });
            } else if (activeType === 'commit') {
                if (over.data.current.type !== 'commit') {
                    return;
                }
                const sourceChangeId = (active.data.current as DragItem & { type: 'commit' }).changeId;
                const targetChangeId = (over.data.current as { changeId?: string }).changeId;

                // Self-target drop safeguard or invalid target
                if (!targetChangeId || sourceChangeId === targetChangeId) {
                    return;
                }

                const message = activeModifier.buildMessagePayload(sourceChangeId, targetChangeId);
                bridge.postMessage(message);
            }
        } finally {
            resetKeys();
        }
    };

    // Render
    if (view === 'details' && detailsCommit) {
        return (
            <CommitDetails
                changeId={detailsCommit.changeId || ''}
                commitId={detailsCommit.commitId || ''}
                description={detailsCommit.description || ''}
                files={detailsCommit.files || []}
                isImmutable={detailsCommit.isImmutable || false}
                isEmpty={detailsCommit.isEmpty}
                isConflict={detailsCommit.isConflict}
                author={detailsCommit.author}
                committer={detailsCommit.committer}
                bookmarks={detailsCommit.bookmarks}
                tags={detailsCommit.tags}
                titleWidthRuler={detailsCommit.titleWidthRuler}
                bodyWidthRuler={detailsCommit.bodyWidthRuler}
                minChangeIdLength={detailsCommit.minChangeIdLength}
                onSave={handleSaveDescription}
                onOpenDiff={handleOpenDiff}
                onOpenMultiDiff={handleOpenMultiDiff}
                onDescriptionChange={(description: string, selectionStart: number, selectionEnd: number) => {
                    bridge.postMessage({
                        type: 'descriptionChanged',
                        payload: { description, selectionStart, selectionEnd },
                    });
                }}
            />
        );
    }

    if (loading) {
        return <div style={{ padding: '20px', color: 'var(--vscode-descriptionForeground)' }}>Loading changes...</div>;
    }

    return (
        <div
            className={`app-container theme-${theme}`}
            style={{ '--commit-left-padding': '6px' } as React.CSSProperties}
        >
            <DndContext
                sensors={sensors}
                collisionDetection={pointerWithin}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
            >
                {/* biome-ignore lint/a11y/noStaticElementInteractions: Background click to deselect is a common pattern in graph views */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handles keyboard deselection separately */}
                <div
                    style={{ flex: 1, overflow: 'auto', minHeight: '100vh' }}
                    onClick={(e) => {
                        // Only clear if clicking the container itself, not children
                        if (e.target === e.currentTarget) {
                            setSelectedCommitIds(new Set());
                            bridge.postMessage({
                                type: 'selectionChange',
                                payload: {
                                    commitIds: [],
                                    hasImmutableSelection: false,
                                },
                            });
                        }
                    }}
                >
                    <CommitGraph
                        commits={commits}
                        onAction={handleGraphAction}
                        selectedCommitIds={selectedCommitIds}
                        minChangeIdLength={minChangeIdLength}
                        graphLabelAlignment={graphLabelAlignment}
                        theme={theme}
                        hiddenActions={hiddenActions}
                        activeModifier={activeModifier}
                    />
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
                            <CommitDragPreview
                                commit={activeDragItem}
                                activeModifier={activeModifier}
                                minChangeIdLength={minChangeIdLength}
                            />
                        ) : null
                    ) : null}
                </DragOverlay>
            </DndContext>
        </div>
    );
};

export default App;
