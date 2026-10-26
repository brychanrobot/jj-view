<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import CommentThreadView from './CommentThreadView.svelte';
import { type CommentsStore, type CommentThreadHandle, normalizeThreadPath } from './comments-store.svelte';

interface Props {
    store: CommentsStore;
    onOpenThread: (handle: CommentThreadHandle) => void;
    onReply: (handle: CommentThreadHandle, text: string, resolve: boolean) => Promise<void>;
    onSetResolved: (handle: CommentThreadHandle, resolved: boolean) => Promise<void>;
    onCopyUnresolved: () => void;
    onRefresh: () => void;
    onClose: () => void;
}

let { store, onOpenThread, onReply, onSetResolved, onCopyUnresolved, onRefresh, onClose }: Props = $props();

interface FileGroup {
    /** Repo-relative path, or undefined for change-level threads. */
    path: string | undefined;
    handles: CommentThreadHandle[];
}

let showResolved = $state(false);

const visibleHandles = $derived(showResolved ? store.handles : store.handles.filter((h) => !h.thread.isResolved));
const resolvedCount = $derived(store.handles.length - store.unresolvedCount);

const groups = $derived.by((): FileGroup[] => {
    const byPath = new Map<string | undefined, CommentThreadHandle[]>();
    for (const handle of visibleHandles) {
        const key = normalizeThreadPath(handle.thread.filePath, store.repoPath);
        const list = byPath.get(key);
        if (list) {
            list.push(handle);
        } else {
            byPath.set(key, [handle]);
        }
    }
    const result: FileGroup[] = [];
    for (const [groupPath, handles] of byPath) {
        handles.sort((a, b) => (a.thread.line ?? 0) - (b.thread.line ?? 0));
        result.push({ path: groupPath, handles });
    }
    // Change-level threads first, then files alphabetically.
    result.sort((a, b) => {
        if (a.path === undefined) {
            return -1;
        }
        if (b.path === undefined) {
            return 1;
        }
        return a.path.localeCompare(b.path);
    });
    return result;
});

function locationLabel(handle: CommentThreadHandle): string | undefined {
    const line = handle.thread.line;
    if (line === undefined || line <= 0) {
        return undefined;
    }
    return `Line ${line}`;
}
</script>

<div class="comments-pane" data-testid="comments-pane">
    <header class="pane-header">
        <span class="pane-title" data-testid="comments-pane-title">
            Comments
            {#if store.activeChange}
                <span class="change-label">· {store.activeChange.displayLabel}</span>
            {/if}
        </span>
        <div class="pane-toolbar">
            {#if store.handles.length > 0}
                <span class="count-badge" data-testid="comments-unresolved-count" title="Unresolved threads">
                    {store.unresolvedCount}
                </span>
            {/if}
            <label class="toggle-resolved" title="Show resolved threads">
                <input type="checkbox" bind:checked={showResolved} data-testid="comments-show-resolved" />
                Resolved ({resolvedCount})
            </label>
            <button
                type="button"
                class="icon-button"
                data-testid="comments-copy-unresolved"
                title="Copy unresolved comments as Markdown"
                disabled={store.unresolvedCount === 0}
                onclick={onCopyUnresolved}
            >
                <i class="codicon codicon-copy" aria-hidden="true"></i>
            </button>
            <button type="button" class="icon-button" data-testid="comments-refresh" title="Refresh" onclick={onRefresh}>
                <i class="codicon codicon-refresh" aria-hidden="true"></i>
            </button>
            <button type="button" class="icon-button" data-testid="comments-close" title="Close" onclick={onClose}>
                <i class="codicon codicon-close" aria-hidden="true"></i>
            </button>
        </div>
    </header>

    <div class="pane-content">
        {#if !store.activeChange}
            <div class="empty-state" data-testid="comments-empty">
                <i class="codicon codicon-comment-discussion large-icon" aria-hidden="true"></i>
                <p>No code review change is associated with the selected commit.</p>
            </div>
        {:else if store.handles.length === 0}
            <div class="empty-state" data-testid="comments-empty">
                <i class="codicon codicon-comment-discussion large-icon" aria-hidden="true"></i>
                <p>No comments on {store.activeChange.displayLabel}.</p>
            </div>
        {:else if visibleHandles.length === 0}
            <div class="empty-state" data-testid="comments-empty">
                <i class="codicon codicon-pass large-icon" aria-hidden="true"></i>
                <p>All {store.handles.length} threads are resolved.</p>
            </div>
        {:else}
            {#each groups as group (group.path ?? '')}
                <section class="file-group" data-testid="comments-file-group">
                    <h3 class="file-heading">
                        {#if group.path}
                            <button
                                type="button"
                                class="file-link"
                                data-testid="comments-file-link"
                                title="Open diff"
                                onclick={() => {
                                    const first = group.handles[0];
                                    if (first) {
                                        onOpenThread(first);
                                    }
                                }}
                            >
                                <i class="codicon codicon-file" aria-hidden="true"></i>
                                {group.path}
                            </button>
                        {:else}
                            <span class="file-link">
                                <i class="codicon codicon-git-commit" aria-hidden="true"></i>
                                Change
                            </span>
                        {/if}
                        <span class="group-count">{group.handles.length}</span>
                    </h3>
                    <div class="thread-list">
                        {#each group.handles as handle (handle.id)}
                            <CommentThreadView
                                {handle}
                                variant="list"
                                location={locationLabel(handle)}
                                onOpenLocation={group.path ? () => onOpenThread(handle) : undefined}
                                onReply={(text, resolve) => onReply(handle, text, resolve)}
                                onSetResolved={(resolved) => onSetResolved(handle, resolved)}
                            />
                        {/each}
                    </div>
                </section>
            {/each}
        {/if}
    </div>
</div>

<style>
.comments-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    min-height: 0;
    background-color: var(--vscode-editor-background, #171717);
    color: var(--vscode-foreground, #d4d4d4);
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    overflow: hidden;
}

.pane-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 35px;
    padding: 0 8px 0 16px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground, #171717);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #1d1d1d);
    font-size: 12px;
    font-weight: 600;
    flex-shrink: 0;
}

.pane-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.change-label {
    font-weight: 400;
    color: var(--vscode-descriptionForeground, #8a8a8a);
}

.pane-toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
}

.count-badge {
    min-width: 18px;
    padding: 0 6px;
    border-radius: 9px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #ffffff);
    font-size: 11px;
    line-height: 18px;
    text-align: center;
}

.toggle-resolved {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0 6px;
    font-weight: 400;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    cursor: pointer;
    user-select: none;
}

.toggle-resolved input {
    margin: 0;
}

.icon-button {
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--vscode-icon-foreground, #8a8a8a);
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.icon-button:disabled {
    opacity: 0.4;
    cursor: default;
}

.icon-button:not(:disabled):hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(31, 62, 94, 0.45));
    color: var(--vscode-foreground);
}

.icon-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: -1px;
}

.pane-content {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 12px 16px;
}

.empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 8px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    text-align: center;
    user-select: none;
}

.empty-state p {
    margin: 0;
    max-width: 360px;
}

.large-icon {
    font-size: 40px;
    color: var(--vscode-icon-foreground, #8a8a8a);
}

.file-group {
    margin-bottom: 14px;
}

.file-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
}

.file-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    font-family: var(--vscode-editor-font-family, monospace);
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

button.file-link {
    cursor: pointer;
    color: var(--vscode-textLink-foreground, #3794ff);
}

button.file-link:hover {
    text-decoration: underline;
}

button.file-link:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 1px;
}

.group-count {
    color: var(--vscode-descriptionForeground, #8a8a8a);
    font-weight: 400;
}

.thread-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
</style>
