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
    type CommitDetailsHostToWebviewMessage,
    CommitDetailsHostToWebviewMessageSchema,
    type CommitDetailsPayload,
    type CommitDetailsToHostMessage,
    CommitDetailsToHostMessageSchema,
} from '../common/ipc/commit-details-schemas';
import {
    type ActionPayload,
    type CommitAction,
    type LogViewHostToWebviewMessage,
    LogViewHostToWebviewMessageSchema,
    type LogViewPayload,
    type LogViewToHostMessage,
    LogViewToHostMessageSchema,
} from '../common/ipc/log-view-schemas';
import type { JjLogEntry, WebviewInitialData } from '../jj-types';
import { BookmarkPill } from './components/Bookmark';
import { CommitDetails } from './components/CommitDetails';
import { CommitDragPreview } from './components/CommitDragPreview';
import { CommitGraph } from './components/CommitGraph';
import { useDragModifiers } from './hooks/useDragModifiers';
import { useBridge, useRpcClient, useRpcDispatcher } from './transport/BridgeContext';
import { snapToCursorLeft } from './utils/modifiers';
import { calculateNextSelection, hasImmutableSelection } from './utils/selection-utils';

type DragItem =
    | { type: 'bookmark'; name: string; remote?: string }
    | (JjLogEntry & { type: 'commit'; changeId: string });

interface CommitDetailsViewProps {
    initialPayload?: CommitDetailsPayload;
}

const CommitDetailsView: React.FC<CommitDetailsViewProps> = ({ initialPayload }) => {
    const [detailsCommit, setDetailsCommit] = React.useState<CommitDetailsPayload | null>(initialPayload || null);
    const rpc = useRpcClient<CommitDetailsToHostMessage>(CommitDetailsToHostMessageSchema);

    useRpcDispatcher<CommitDetailsHostToWebviewMessage>(CommitDetailsHostToWebviewMessageSchema, {
        updateDetails: (payload) => {
            setDetailsCommit(payload);
        },
        saveComplete: ({ description }) => {
            setDetailsCommit((prev) => (prev ? { ...prev, description } : prev));
        },
        saveFailed: () => {},
        updateDescription: () => {},
    });

    React.useEffect(() => {
        void rpc.webviewLoaded();
    }, [rpc]);

    if (!detailsCommit) {
        return (
            <div style={{ padding: '20px', color: 'var(--vscode-descriptionForeground)' }}>
                Loading commit details...
            </div>
        );
    }

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
            onSave={(description) => {
                if (detailsCommit.changeId) {
                    void rpc.saveDescription({ changeId: detailsCommit.changeId, description });
                }
            }}
            onOpenDiff={(file, isImmutable) => {
                if (detailsCommit.changeId) {
                    void rpc.openDiff({ changeId: detailsCommit.changeId, file, isImmutable });
                }
            }}
            onOpenMultiDiff={() => {
                if (detailsCommit.changeId) {
                    void rpc.openMultiDiff({ changeId: detailsCommit.changeId });
                }
            }}
            onDescriptionChange={(description, selectionStart, selectionEnd) => {
                void rpc.descriptionChanged({ description, selectionStart, selectionEnd });
            }}
        />
    );
};

interface LogViewProps {
    initialPayload?: LogViewPayload;
}

const LogView: React.FC<LogViewProps> = ({ initialPayload }) => {
    const [commits, setCommits] = React.useState<JjLogEntry[]>(initialPayload?.commits || []);
    const [minChangeIdLength, setMinChangeIdLength] = React.useState<number>(initialPayload?.minChangeIdLength || 1);
    const [theme, setTheme] = React.useState<string>(initialPayload?.theme || 'default');
    const [graphLabelAlignment, setGraphLabelAlignment] = React.useState<string>(
        initialPayload?.graphLabelAlignment || 'aligned',
    );
    const [loading, setLoading] = React.useState(!(initialPayload?.commits && initialPayload.commits.length > 0));
    const [selectedCommitIds, setSelectedCommitIds] = React.useState<Set<string>>(new Set());
    const [hiddenActions, setHiddenActions] = React.useState<Set<CommitAction>>(
        new Set(initialPayload?.hiddenActions || []),
    );

    const commitsRef = React.useRef(commits);
    React.useEffect(() => {
        commitsRef.current = commits;
    }, [commits]);

    const rpc = useRpcClient<LogViewToHostMessage>(LogViewToHostMessageSchema);

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

    useRpcDispatcher<LogViewHostToWebviewMessage>(LogViewHostToWebviewMessageSchema, {
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

                    void rpc.selectionChange({
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
                if (changeId && prevIds.has(changeId) && prevIds.size === 1) {
                    const clearedIds = new Set<string>();
                    void rpc.selectionChange({
                        commitIds: [],
                        hasImmutableSelection: false,
                    });
                    return clearedIds;
                }
                return prevIds;
            });
        },
        setSelection: ({ ids }) => {
            const newIds = new Set<string>(ids || []);
            setSelectedCommitIds(newIds);
            const hasImmutable = hasImmutableSelection(newIds, commitsRef.current);

            void rpc.selectionChange({
                commitIds: Array.from(newIds),
                hasImmutableSelection: hasImmutable,
            });
        },
    });

    React.useEffect(() => {
        void rpc.webviewLoaded();
    }, [rpc]);

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setSelectedCommitIds(new Set());
                void rpc.selectionChange({
                    commitIds: [],
                    hasImmutableSelection: false,
                });
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [rpc]);

    const handleGraphAction = (action: string, payload: ActionPayload) => {
        if (action === 'select') {
            const { changeId, multiSelect } = payload;
            const nextSelectedIds = calculateNextSelection(selectedCommitIds, changeId, Boolean(multiSelect));
            setSelectedCommitIds(nextSelectedIds);

            const hasImmutable = hasImmutableSelection(nextSelectedIds, commits);
            void rpc.selectionChange({
                commitIds: Array.from(nextSelectedIds),
                hasImmutableSelection: hasImmutable,
            });

            if (nextSelectedIds.has(changeId)) {
                void rpc.getDetails(payload);
            }
            return;
        }

        if (action === 'showComments') {
            void rpc.showComments({ changeId: payload.changeId });
            return;
        }

        if (action === 'contextMenu') {
            void rpc.contextMenu({
                ...payload,
                selectedCommitIds: Array.from(selectedCommitIds),
            });
            return;
        }

        if (action === 'new') {
            void rpc.new();
            return;
        }
        if (action === 'newChild') {
            void rpc.newChild(payload);
            return;
        }
        if (action === 'edit') {
            void rpc.edit(payload);
            return;
        }
        if (action === 'squash') {
            void rpc.squash(payload);
            return;
        }
        if (action === 'abandon') {
            void rpc.abandon(payload);
            return;
        }
        if (action === 'undo') {
            void rpc.undo();
            return;
        }
        if (action === 'redo') {
            void rpc.redo();
            return;
        }
        if (action === 'upload') {
            void rpc.upload(payload);
            return;
        }
        if (action === 'openCodeForge' && payload.url) {
            void rpc.openCodeForge({ url: payload.url });
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

                void rpc.moveBookmark({ bookmark: bookmarkName, targetChangeId });
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
                    void rpc.rebaseCommit(message.payload);
                } else if (message.type === 'squashCommit') {
                    void rpc.squashCommit(message.payload);
                } else if (message.type === 'duplicateCommit') {
                    void rpc.duplicateCommit(message.payload);
                } else if (message.type === 'mergeCommit') {
                    void rpc.mergeCommit(message.payload);
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
                            void rpc.selectionChange({
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

const App: React.FC = () => {
    const bridge = useBridge();
    const initialData = bridge.getInitialData<WebviewInitialData>();
    const view = initialData?.view || 'graph';

    if (view === 'details') {
        return <CommitDetailsView initialPayload={initialData?.payload as CommitDetailsPayload | undefined} />;
    }
    return <LogView initialPayload={initialData?.payload as LogViewPayload | undefined} />;
};

export default App;
