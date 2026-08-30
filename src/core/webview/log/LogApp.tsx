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
import {
    type ActionPayload,
    type CommitAction,
    type LogViewHostToWebviewMessage,
    LogViewHostToWebviewMessageSchema,
    type LogViewToHostMessage,
    LogViewToHostMessageSchema,
} from '../../host/ipc/log-view-schemas';
import type { JjLogEntry } from '../../jj-types';
import { BookmarkPill } from '../common/components/Bookmark';
import { useRpcReceiver, useRpcSender } from '../transport/BridgeContext';
import { type CommitDragData, CommitDragPreview } from './components/CommitDragPreview';
import { CommitGraph } from './components/CommitGraph';
import { useDragModifiers } from './hooks/useDragModifiers';
import { snapToCursorLeft } from './utils/modifiers';
import { calculateNextSelection, hasImmutableSelection } from './utils/selection-utils';

type DragItem = { type: 'bookmark'; name: string; remote?: string } | (CommitDragData & { type: 'commit' });

export const LogApp: React.FC = () => {
    const [commits, setCommits] = React.useState<JjLogEntry[]>([]);
    const [minChangeIdLength, setMinChangeIdLength] = React.useState<number>(1);
    const [theme, setTheme] = React.useState<string>('default');
    const [graphLabelAlignment, setGraphLabelAlignment] = React.useState<string>('aligned');
    const [loading, setLoading] = React.useState<boolean>(true);
    const [selectedCommitIds, setSelectedCommitIds] = React.useState<Set<string>>(new Set());
    const [hiddenActions, setHiddenActions] = React.useState<Set<CommitAction>>(new Set());

    const commitsRef = React.useRef(commits);
    React.useEffect(() => {
        commitsRef.current = commits;
    }, [commits]);

    const sender = useRpcSender<LogViewToHostMessage>(LogViewToHostMessageSchema);

    // Drag State
    const [activeDragItem, setActiveDragItem] = React.useState<DragItem | null>(null);
    const { activeModifier, resetKeys } = useDragModifiers();

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

    useRpcReceiver<LogViewHostToWebviewMessage>(LogViewHostToWebviewMessageSchema, {
        update: ({
            commits: newCommits,
            minChangeIdLength: minLen,
            theme: th,
            graphLabelAlignment: align,
            hiddenActions: hidden,
        }) => {
            setCommits(newCommits);
            if (minLen !== undefined) {
                setMinChangeIdLength(minLen);
            }
            if (th !== undefined) {
                setTheme(th);
            }
            if (align !== undefined) {
                setGraphLabelAlignment(align);
            }
            if (hidden !== undefined) {
                setHiddenActions(new Set(hidden));
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

                    void sender.selectionChange({
                        commitIds: validIds,
                        hasImmutableSelection: hasImmutable,
                    });
                    return newIds;
                }

                return prevIds;
            });
        },
        updateHiddenActions: ({ hiddenActions: hidden }) => {
            setHiddenActions(new Set(hidden));
        },
        panelClosed: ({ changeId }) => {
            setSelectedCommitIds((prevIds) => {
                if (prevIds.has(changeId) && prevIds.size === 1) {
                    void sender.selectionChange({
                        commitIds: [],
                        hasImmutableSelection: false,
                    });
                    return new Set();
                }
                return prevIds;
            });
        },
        setSelection: ({ ids }) => {
            const newIds = new Set(ids);
            setSelectedCommitIds(newIds);
            const hasImmutable = hasImmutableSelection(newIds, commitsRef.current);
            void sender.selectionChange({
                commitIds: ids,
                hasImmutableSelection: hasImmutable,
            });
        },
    });

    React.useEffect(() => {
        void sender.webviewLoaded();
    }, [sender]);

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setSelectedCommitIds(new Set());
                void sender.selectionChange({
                    commitIds: [],
                    hasImmutableSelection: false,
                });
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [sender]);

    const handleGraphAction = (action: string, payload: ActionPayload) => {
        if (action === 'select') {
            const multiSelect = payload.multiSelect ?? false;
            const newSelection = calculateNextSelection(selectedCommitIds, payload.changeId, multiSelect);
            setSelectedCommitIds(newSelection);

            const commitIds = Array.from(newSelection);
            const hasImmutable = hasImmutableSelection(newSelection, commitsRef.current);

            void sender.selectionChange({
                commitIds,
                hasImmutableSelection: hasImmutable,
            });

            if (newSelection.has(payload.changeId)) {
                void sender.getDetails(payload);
            }
            return;
        }

        if (action === 'showComments') {
            void sender.showComments({ changeId: payload.changeId });
            return;
        }

        if (action === 'contextMenu') {
            void sender.contextMenu({
                ...payload,
                selectedCommitIds: Array.from(selectedCommitIds),
            });
            return;
        }

        if (action === 'new') {
            void sender.new();
            return;
        }
        if (action === 'newChild') {
            void sender.newChild(payload);
            return;
        }
        if (action === 'edit') {
            void sender.edit(payload);
            return;
        }
        if (action === 'squash') {
            void sender.squash(payload);
            return;
        }
        if (action === 'abandon') {
            void sender.abandon(payload);
            return;
        }
        if (action === 'undo') {
            void sender.undo();
            return;
        }
        if (action === 'redo') {
            void sender.redo();
            return;
        }
        if (action === 'upload') {
            void sender.upload(payload);
            return;
        }
        if (action === 'openCodeForge' && payload.url) {
            void sender.openCodeForge({ url: payload.url });
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
                const bookmarkName = (active.data.current as DragItem & { type: 'bookmark' }).name;
                const bookmarkRemote = (active.data.current as DragItem & { type: 'bookmark' }).remote;
                const targetChangeId = over.data.current.changeId;

                setCommits((prevCommits) => {
                    const sourceCommit = prevCommits.find((c) =>
                        c.bookmarks?.some((b) => b.name === bookmarkName && b.remote === bookmarkRemote),
                    );

                    if (!sourceCommit || sourceCommit.change_id === targetChangeId) {
                        return prevCommits;
                    }

                    return prevCommits.map((commit) => {
                        let newBookmarks = commit.bookmarks || [];

                        if (newBookmarks.some((b) => b.name === bookmarkName && b.remote === bookmarkRemote)) {
                            newBookmarks = newBookmarks.filter(
                                (b) => !(b.name === bookmarkName && b.remote === bookmarkRemote),
                            );
                        }

                        if (commit.change_id === targetChangeId) {
                            newBookmarks = [...newBookmarks, { name: bookmarkName, remote: bookmarkRemote }];
                        }

                        if (newBookmarks !== commit.bookmarks) {
                            return { ...commit, bookmarks: newBookmarks };
                        }
                        return commit;
                    });
                });

                void sender.moveBookmark({ bookmark: bookmarkName, targetChangeId });
                return;
            }

            if (activeType === 'commit') {
                if (over.data.current.type !== 'commit') {
                    return;
                }
                const sourceChangeId = (active.data.current as DragItem & { type: 'commit' }).changeId;
                const targetChangeId = (over.data.current as { changeId?: string }).changeId;

                if (!targetChangeId || sourceChangeId === targetChangeId) {
                    return;
                }

                const message = activeModifier.buildMessagePayload(sourceChangeId, targetChangeId);
                if (message.type === 'rebaseCommit') {
                    void sender.rebaseCommit(message.payload);
                } else if (message.type === 'squashCommit') {
                    void sender.squashCommit(message.payload);
                } else if (message.type === 'duplicateCommit') {
                    void sender.duplicateCommit(message.payload);
                } else if (message.type === 'mergeCommit') {
                    void sender.mergeCommit(message.payload);
                }
            }
        } finally {
            resetKeys();
        }
    };

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
                        if (e.target === e.currentTarget) {
                            setSelectedCommitIds(new Set());
                            void sender.selectionChange({
                                commitIds: [],
                                hasImmutableSelection: false,
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

export default LogApp;
