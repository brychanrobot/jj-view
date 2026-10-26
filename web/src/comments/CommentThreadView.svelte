<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { ACK_REPLY_TEXT, DONE_REPLY_TEXT } from '../../../src/core/comments-constants';
import { getRelativeTimeString } from '../../../src/core/webview/common/utils/time-utils';
import type { CommentThreadHandle } from './comments-store.svelte';

interface Props {
    handle: CommentThreadHandle;
    /** `inline` is rendered inside a diff; `list` in the comments pane. */
    variant?: 'inline' | 'list';
    /** Shown in the header for the list variant, e.g. `src/app.ts:42`. */
    location?: string;
    onOpenLocation?: () => void;
    onReply: (text: string, resolve: boolean) => Promise<void>;
    onSetResolved: (resolved: boolean) => Promise<void>;
}

let { handle, variant = 'list', location, onOpenLocation, onReply, onSetResolved }: Props = $props();

const thread = $derived(handle.thread);
const isResolved = $derived(thread.isResolved);

let replyText = $state('');
let busy = $state(false);
// Resolved threads start collapsed, like the extension's comment widgets.
// svelte-ignore state_referenced_locally
let expanded = $state(!handle.thread.isResolved);

const canSend = $derived(replyText.trim().length > 0 && !busy);

async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
        return;
    }
    busy = true;
    try {
        await action();
    } finally {
        busy = false;
    }
}

async function sendReply(resolve: boolean): Promise<void> {
    const text = replyText.trim();
    if (!text) {
        return;
    }
    await run(async () => {
        await onReply(text, resolve);
        replyText = '';
    });
}

function quickReply(text: string): void {
    void run(() => onReply(text, true));
}

function toggleResolved(): void {
    void run(() => onSetResolved(!isResolved));
}

function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canSend) {
        event.preventDefault();
        void sendReply(false);
    }
}
</script>

<div
    class="comment-thread {variant}"
    class:resolved={isResolved}
    class:collapsed={!expanded}
    data-testid="comment-thread"
    data-thread-id={thread.id}
    data-resolved={isResolved}
>
    <div class="thread-header">
        <button
            type="button"
            class="thread-toggle"
            aria-expanded={expanded}
            data-testid="comment-thread-toggle"
            onclick={() => {
                expanded = !expanded;
            }}
        >
            <i class="codicon {expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}" aria-hidden="true"></i>
            <span class="thread-state" data-testid="comment-thread-state">
                <i class="codicon {isResolved ? 'codicon-pass' : 'codicon-comment-discussion'}" aria-hidden="true"></i>
                {isResolved ? 'Resolved' : 'Unresolved'}
            </span>
            <span class="thread-count">
                {thread.comments.length}
                {thread.comments.length === 1 ? 'comment' : 'comments'}
            </span>
        </button>
        {#if location}
            {#if onOpenLocation}
                <button
                    type="button"
                    class="thread-location link"
                    data-testid="comment-thread-location"
                    title="Open in diff"
                    onclick={onOpenLocation}>{location}</button
                >
            {:else}
                <span class="thread-location">{location}</span>
            {/if}
        {/if}
    </div>

    {#if expanded}
        <ul class="comment-list">
            {#each thread.comments as comment (comment.id)}
                <li class="comment" data-testid="comment">
                    <div class="comment-meta">
                        {#if comment.author.avatarUrl}
                            <img class="avatar" src={comment.author.avatarUrl} alt="" />
                        {:else}
                            <span class="avatar avatar-fallback" aria-hidden="true">
                                {(comment.author.name || '?').slice(0, 1).toUpperCase()}
                            </span>
                        {/if}
                        <span class="author">{comment.author.name || 'Unknown'}</span>
                        {#if comment.isDraft}
                            <span class="draft-badge">Draft</span>
                        {/if}
                        <span class="timestamp" title={comment.createdAt}>{getRelativeTimeString(comment.createdAt)}</span>
                    </div>
                    <div class="comment-body">{comment.body}</div>
                </li>
            {/each}
        </ul>

        <div class="reply-area">
            <textarea
                class="reply-input"
                data-testid="comment-reply-input"
                placeholder="Reply…"
                rows="2"
                bind:value={replyText}
                disabled={busy}
                onkeydown={handleKeyDown}
            ></textarea>
            <div class="reply-actions">
                {#if !isResolved}
                    <button
                        type="button"
                        class="action secondary"
                        data-testid="comment-ack"
                        title="Reply “{ACK_REPLY_TEXT}” and resolve"
                        disabled={busy}
                        onclick={() => quickReply(ACK_REPLY_TEXT)}>Ack</button
                    >
                    <button
                        type="button"
                        class="action secondary"
                        data-testid="comment-done"
                        title="Reply “{DONE_REPLY_TEXT}” and resolve"
                        disabled={busy}
                        onclick={() => quickReply(DONE_REPLY_TEXT)}>Done</button
                    >
                {/if}
                <span class="spacer"></span>
                <button
                    type="button"
                    class="action secondary"
                    data-testid="comment-toggle-resolved"
                    disabled={busy}
                    onclick={toggleResolved}>{isResolved ? 'Unresolve' : 'Resolve'}</button
                >
                {#if !isResolved}
                    <button
                        type="button"
                        class="action secondary"
                        data-testid="comment-reply-resolve"
                        disabled={!canSend}
                        onclick={() => sendReply(true)}>Reply &amp; Resolve</button
                    >
                {/if}
                <button
                    type="button"
                    class="action primary"
                    data-testid="comment-reply"
                    disabled={!canSend}
                    onclick={() => sendReply(false)}>Reply</button
                >
            </div>
        </div>
    {/if}
</div>

<style>
.comment-thread {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--vscode-widget-border, #303031);
    border-radius: 6px;
    background-color: var(--vscode-editorWidget-background, var(--vscode-editor-background, #171717));
    color: var(--vscode-foreground, #d4d4d4);
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    line-height: 1.45;
    overflow: hidden;
}

.comment-thread.inline {
    margin: 4px 8px 6px 8px;
    /* Pierre renders the diff in a monospace <pre>; annotations should not inherit it. */
    white-space: normal;
    text-align: left;
}

.comment-thread.resolved {
    border-color: var(--vscode-widget-border, #303031);
    opacity: 0.9;
}

.thread-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 10px;
    background: var(--vscode-editorGroupHeader-tabsBackground, #1a1a1a);
}

.thread-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
}

.thread-toggle:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
}

.thread-toggle:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: -1px;
}

.thread-state {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
}

.comment-thread:not(.resolved) .thread-state {
    color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
}

.comment-thread.resolved .thread-state {
    color: var(--vscode-testing-iconPassed, var(--vscode-descriptionForeground));
}

.thread-count {
    color: var(--vscode-descriptionForeground, #8a8a8a);
}

.thread-location {
    flex-shrink: 1;
    min-width: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.thread-location.link {
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
}

.thread-location.link:hover {
    text-decoration: underline;
}

.thread-location.link:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 1px;
}

.comment-list {
    list-style: none;
    margin: 0;
    padding: 0;
}

.comment {
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-widget-border, #303031);
}

.comment-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    font-size: 12px;
}

.avatar {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
}

.avatar-fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #ffffff);
    font-size: 10px;
    font-weight: 600;
}

.author {
    font-weight: 600;
}

.draft-badge {
    padding: 0 5px;
    border-radius: 4px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #ffffff);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
}

.timestamp {
    margin-left: auto;
    color: var(--vscode-descriptionForeground, #8a8a8a);
}

.comment-body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.reply-area {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-widget-border, #303031);
}

.reply-input {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 36px;
    padding: 6px 8px;
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #303031));
    border-radius: 6px;
    background: var(--vscode-input-background, #262626);
    color: var(--vscode-input-foreground, inherit);
    font: inherit;
}

.reply-input:focus {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: -1px;
}

.reply-actions {
    display: flex;
    align-items: center;
    gap: 6px;
}

.spacer {
    flex: 1;
}

.action {
    padding: 3px 10px;
    border: 1px solid transparent;
    border-radius: 4px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
}

.action:disabled {
    opacity: 0.5;
    cursor: default;
}

.action.primary {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
}

.action.primary:not(:disabled):hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
}

.action.secondary {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ffffff);
}

.action.secondary:not(:disabled):hover {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
}

.action:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 1px;
}
</style>
