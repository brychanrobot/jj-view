<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import {
    type ActionPayload,
    type CommitAction,
    type LogViewHostToWebviewMessage,
    LogViewHostToWebviewMessageSchema,
    type LogViewToHostMessage,
    LogViewToHostMessageSchema,
} from '../../host/ipc/log-view-schemas';
import type { JjLogEntry } from '../../jj-types';
import { BookmarkPill } from '../common/components';
import { useRpcReceiver, useRpcSender } from '../transport/bridge.svelte';
import CommitDragPreview from './components/CommitDragPreview.svelte';
import CommitGraph from './components/CommitGraph.svelte';
import { DragManager } from './drag-manager.svelte';
import { calculateNextSelection, hasImmutableSelection } from './utils/selection-utils';

let commits = $state<JjLogEntry[]>([]);
let minChangeIdLength = $state(1);
let theme = $state('default');
let graphLabelAlignment = $state('aligned');
let loading = $state(true);
let selectedCommitIds = $state<Set<string>>(new Set());
let hiddenActions = $state<Set<CommitAction>>(new Set());

const sender = useRpcSender<LogViewToHostMessage>(LogViewToHostMessageSchema);

const dragManager = new DragManager((item, target, modifier) => {
    if (item.type === 'bookmark') {
        const bookmarkName = item.name;
        const bookmarkRemote = item.remote;
        const targetChangeId = target.changeId;

        const sourceCommit = commits.find((c) =>
            c.bookmarks?.some((b) => b.name === bookmarkName && b.remote === bookmarkRemote),
        );
        if (!sourceCommit || sourceCommit.change_id === targetChangeId) {
            return;
        }

        commits = commits.map((commit) => {
            let newBookmarks = commit.bookmarks || [];
            if (newBookmarks.some((b) => b.name === bookmarkName && b.remote === bookmarkRemote)) {
                newBookmarks = newBookmarks.filter((b) => !(b.name === bookmarkName && b.remote === bookmarkRemote));
            }
            if (commit.change_id === targetChangeId) {
                newBookmarks = [...newBookmarks, { name: bookmarkName, remote: bookmarkRemote }];
            }
            return { ...commit, bookmarks: newBookmarks };
        });

        void sender.moveBookmark({ bookmark: bookmarkName, targetChangeId });
        return;
    }

    if (item.type === 'commit') {
        const sourceChangeId = item.changeId;
        const targetChangeId = target.changeId;
        if (!targetChangeId || sourceChangeId === targetChangeId) {
            return;
        }

        const message = modifier.buildMessagePayload(sourceChangeId, targetChangeId);
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
});

$effect(() => {
    if (dragManager.isDragging) {
        document.body.style.userSelect = 'none';
        return () => {
            document.body.style.userSelect = '';
        };
    }
});

useRpcReceiver<LogViewHostToWebviewMessage>(LogViewHostToWebviewMessageSchema, {
    update: ({
        commits: newCommits,
        minChangeIdLength: minLen,
        theme: th,
        graphLabelAlignment: align,
        hiddenActions: hidden,
    }) => {
        commits = newCommits;
        if (minLen !== undefined) {
            minChangeIdLength = minLen;
        }
        if (th !== undefined) {
            theme = th;
        }
        if (align !== undefined) {
            graphLabelAlignment = align;
        }
        if (hidden !== undefined) {
            hiddenActions = new Set(hidden);
        }
        loading = false;

        if (selectedCommitIds.size > 0) {
            const validIds = Array.from(selectedCommitIds).filter((id) =>
                newCommits.some((c: JjLogEntry) => c.change_id === id),
            );

            if (validIds.length !== selectedCommitIds.size) {
                const newIds = new Set(validIds);
                selectedCommitIds = newIds;
                const hasImmutable = hasImmutableSelection(newIds, newCommits);
                void sender.selectionChange({
                    commitIds: validIds,
                    hasImmutableSelection: hasImmutable,
                });
            }
        }
    },
    updateHiddenActions: ({ hiddenActions: hidden }) => {
        hiddenActions = new Set(hidden);
    },
    panelClosed: ({ changeId }) => {
        if (selectedCommitIds.has(changeId) && selectedCommitIds.size === 1) {
            selectedCommitIds = new Set();
            void sender.selectionChange({
                commitIds: [],
                hasImmutableSelection: false,
            });
        }
    },
    setSelection: ({ ids }) => {
        const newIds = new Set(ids);
        selectedCommitIds = newIds;
        const hasImmutable = hasImmutableSelection(newIds, commits);
        void sender.selectionChange({
            commitIds: ids,
            hasImmutableSelection: hasImmutable,
        });
    },
});

$effect(() => {
    void sender.webviewLoaded();
});

function handleGraphAction(action: string, payload: ActionPayload) {
    if (action === 'select') {
        const multiSelect = payload.multiSelect ?? false;
        const newSelection = calculateNextSelection(selectedCommitIds, payload.changeId, multiSelect);
        selectedCommitIds = newSelection;

        const commitIds = Array.from(newSelection);
        const hasImmutable = hasImmutableSelection(newSelection, commits);

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
}
</script>

<svelte:window
    onkeydown={(e) => {
        dragManager.handleKeyDown(e);
        if (e.key === 'Escape') {
            selectedCommitIds = new Set();
            void sender.selectionChange({
                commitIds: [],
                hasImmutableSelection: false,
            });
        }
    }}
    onkeyup={(e) => dragManager.handleKeyUp(e)}
    onblur={() => dragManager.handleWindowBlur()}
/>

{#if loading}
    <div class="loading-state">
        Loading changes...
    </div>
{:else}
    <div
        class="app-container theme-{theme}"
        style="--commit-left-padding: 6px;"
    >
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="scroll-container"
            onclick={(e) => {
                if (e.target === e.currentTarget) {
                    selectedCommitIds = new Set();
                    void sender.selectionChange({
                        commitIds: [],
                        hasImmutableSelection: false,
                    });
                }
            }}
        >
            <CommitGraph
                {commits}
                onAction={handleGraphAction}
                {selectedCommitIds}
                {minChangeIdLength}
                {graphLabelAlignment}
                {theme}
                {hiddenActions}
                {dragManager}
            />
        </div>

        <!-- Floating Drag Preview Overlay -->
        {#if dragManager.activeDragItem}
            <div
                class="drag-preview-overlay"
                style:left={dragManager.activeDragItem.type === 'commit'
                    ? `${dragManager.pointerPos.x - 5}px`
                    : `${dragManager.pointerPos.x - 10}px`}
                style:top={dragManager.activeDragItem.type === 'commit'
                    ? `${dragManager.pointerPos.y - 24}px`
                    : `${dragManager.pointerPos.y - 11}px`}
            >
                {#if dragManager.activeDragItem.type === 'bookmark'}
                    <div class="bookmark-preview-wrapper">
                        <BookmarkPill
                            bookmark={{
                                name: dragManager.activeDragItem.name,
                                remote: dragManager.activeDragItem.remote,
                            }}
                        />
                    </div>
                {:else if dragManager.activeDragItem.type === 'commit'}
                    <CommitDragPreview
                        commit={dragManager.activeDragItem}
                        activeModifier={dragManager.activeModifier}
                        {minChangeIdLength}
                    />
                {/if}
            </div>
        {/if}
    </div>
{/if}

<style>
    .loading-state {
        padding: 20px;
        color: var(--vscode-descriptionForeground);
    }

    .scroll-container {
        flex: 1;
        overflow: auto;
        min-height: 100vh;
    }

    .drag-preview-overlay {
        position: fixed;
        pointer-events: none;
        z-index: 10000;
        will-change: left, top;
    }

    .bookmark-preview-wrapper {
        cursor: grabbing;
        opacity: 1;
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    }
</style>

