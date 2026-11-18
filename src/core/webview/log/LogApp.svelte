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
    type LogViewPayload,
    type LogViewToHostMessage,
    LogViewToHostMessageSchema,
} from '../../host/ipc/log-view-schemas';
import type { JjLogEntry } from '../../jj-types';
import { BookmarkPill } from '../common/components';
import { useRpcReceiver, useRpcSender } from '../transport/bridge.svelte';
import CommitDragPreview from './components/CommitDragPreview.svelte';
import CommitGraph from './components/CommitGraph.svelte';
import { DragManager } from './drag-manager.svelte';
import { findMatchingCommit } from './utils/commit-utils';
import { calculateNextSelection, hasImmutableSelection } from './utils/selection-utils';

interface Props {
    initialState?: LogViewPayload;
}

let { initialState }: Props = $props();

// svelte-ignore state_referenced_locally
let commits = $state<JjLogEntry[]>(initialState?.commits ?? []);
// svelte-ignore state_referenced_locally
let minChangeIdLength = $state(initialState?.minChangeIdLength ?? 1);
// svelte-ignore state_referenced_locally
let theme = $state(initialState?.theme ?? 'default');
// svelte-ignore state_referenced_locally
let graphLabelAlignment = $state(initialState?.graphLabelAlignment ?? 'aligned');
// svelte-ignore state_referenced_locally
let loading = $state(initialState === undefined);
// svelte-ignore state_referenced_locally
let hasRepository = $state(initialState?.hasRepository ?? true);
// svelte-ignore state_referenced_locally
let errorMessage = $state<string | undefined>(initialState?.errorMessage);
let selectedCommitIds = $state<Set<string>>(new Set());
let rawHighlightQuery = $state<string | undefined>(undefined);
const highlightedCommit = $derived(findMatchingCommit(commits, rawHighlightQuery));
const highlightedCommitId = $derived(highlightedCommit?.change_id);
// svelte-ignore state_referenced_locally
let hiddenActions = $state<Set<CommitAction>>(new Set(initialState?.hiddenActions ?? []));

function scrollToCommit(changeId: string) {
    if (typeof document === 'undefined') {
        return;
    }
    const escaped = CSS.escape(changeId);
    const element = document.querySelector<HTMLElement>(`.commit-row[data-change-id="${escaped}"]`);
    if (element) {
        element.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
}

const sender = useRpcSender<LogViewToHostMessage>(LogViewToHostMessageSchema);

let overlayEl = $state<HTMLElement | null>(null);

const overlayPos = $derived.by(() => {
    if (!dragManager.activeDragItem) {
        return { left: 0, top: 0 };
    }
    // Track modifier and pressed key changes so clamping recalculates when card dimension changes in place
    void dragManager.activeModifier;
    void dragManager.pressedKeys;

    const isCommit = dragManager.activeDragItem.type === 'commit';
    const offsetX = isCommit ? -5 : -10;
    const offsetY = isCommit ? -24 : -11;
    let x = dragManager.pointerPos.x + offsetX;
    let y = dragManager.pointerPos.y + offsetY;

    if (overlayEl && typeof window !== 'undefined') {
        const rect = overlayEl.getBoundingClientRect();
        const maxX = window.innerWidth - rect.width - 8;
        const maxY = window.innerHeight - rect.height - 8;
        if (x > maxX) {
            x = Math.max(8, maxX);
        }
        if (y > maxY) {
            y = Math.max(8, maxY);
        }
        if (x < 8) {
            x = 8;
        }
        if (y < 8) {
            y = 8;
        }
    }
    return { left: x, top: y };
});

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
        hasRepository: hasRepo,
        errorMessage: errMsg,
    }) => {
        commits = newCommits;
        hasRepository = hasRepo ?? true;
        errorMessage = errMsg;
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
    setHighlight: ({ changeId }) => {
        rawHighlightQuery = changeId;
    },
});

$effect(() => {
    if (highlightedCommitId) {
        scrollToCommit(highlightedCommitId);
    }
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
    if (action === 'compareWithUploaded') {
        void sender.compareWithUploaded(payload);
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
            if (dragManager.isDragging) {
                dragManager.cancelDrag();
                return;
            }
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
    <div class="loading-state" role="status" aria-live="polite">
        Loading changes...
    </div>
{:else if !hasRepository}
    <div class="status-scroll-container">
        <div class="log-status-state log-no-repo-state" data-testid="log-no-repo-state" role="status">
            <span class="codicon codicon-repo log-status-icon" aria-hidden="true"></span>
            <p class="log-status-title">No Jujutsu repository found in this workspace.</p>
        </div>
    </div>
{:else if errorMessage && commits.length === 0}
    <div class="status-scroll-container">
        <div class="log-status-state log-error-state" data-testid="log-error-state" role="alert">
            <span class="codicon codicon-error log-status-icon" aria-hidden="true"></span>
            <p class="log-status-title">Unable to load Jujutsu log</p>
            <p class="log-status-detail">{errorMessage}</p>
        </div>
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
                {highlightedCommitId}
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
                bind:this={overlayEl}
                class="drag-preview-overlay"
                style:left={`${overlayPos.left}px`}
                style:top={`${overlayPos.top}px`}
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

    .status-scroll-container {
        flex: 1 1 0;
        min-height: 0;
        height: 100%;
        overflow-y: auto;
        overflow-x: hidden;
    }

    .log-status-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 20px 16px;
        margin: 0;
        text-align: center;
        color: var(--vscode-descriptionForeground);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        line-height: 1.4;
    }

    .log-status-icon.codicon {
        font-size: 24px;
        color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground));
        opacity: 0.85;
    }

    .log-status-title {
        margin: 0;
        color: var(--vscode-descriptionForeground);
        font-size: var(--vscode-font-size);
    }

    .log-error-state .log-status-icon.codicon {
        color: var(--vscode-errorForeground, var(--vscode-descriptionForeground));
        opacity: 1;
    }

    .log-error-state .log-status-title {
        color: var(--vscode-errorForeground, var(--vscode-descriptionForeground));
        font-weight: 600;
    }

    .log-status-detail {
        margin: 0;
        max-width: 100%;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        overflow-wrap: anywhere;
        word-break: break-word;
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
        box-shadow: 0 4px 8px color-mix(in srgb, var(--vscode-widget-shadow, var(--vscode-foreground)) 20%, transparent);
    }
</style>

