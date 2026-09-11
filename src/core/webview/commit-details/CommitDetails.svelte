<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { tick, untrack } from 'svelte';
import { formatCommitDescription } from '../../../utils/format-utils';
import { formatDisplayChangeId } from '../../../utils/jj-utils';
import {
    type CommitDetailsHostToWebviewMessage,
    CommitDetailsHostToWebviewMessageSchema,
} from '../../host/ipc/commit-details-schemas';
import type { JjBookmark, JjStatusEntry } from '../../jj-types';
import { BasePill, BookmarkPill, PersonInfo, TagPill } from '../common/components';
import { useRpcReceiver } from '../transport/bridge.svelte';

interface Props {
    changeId: string;
    commitId: string;
    description: string;
    files: JjStatusEntry[];
    isImmutable: boolean;
    isEmpty?: boolean;
    isConflict?: boolean;
    author?: { name: string; email: string; timestamp: string };
    committer?: { name: string; email: string; timestamp: string };
    bookmarks?: JjBookmark[];
    tags?: string[];
    titleWidthRuler?: number;
    bodyWidthRuler?: number;
    minChangeIdLength?: number;
    onSave: (description: string) => void;
    onOpenDiff: (file: JjStatusEntry, isImmutable: boolean) => void;
    onOpenMultiDiff: () => void;
    onDescriptionChange?: (description: string, selectionStart: number, selectionEnd: number) => void;
}

let {
    changeId,
    commitId,
    description,
    files,
    isImmutable,
    isEmpty = false,
    isConflict = false,
    author,
    committer,
    bookmarks = [],
    tags = [],
    titleWidthRuler = 50,
    bodyWidthRuler = 72,
    minChangeIdLength = 1,
    onSave,
    onOpenDiff,
    onOpenMultiDiff,
    onDescriptionChange,
}: Props = $props();

let draftDescription = $state(description);
let prevDescription = $state(description);
let isSaving = $state(false);
let isApplyingExtensionEdit = false;
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

let textareaRef = $state<HTMLTextAreaElement | null>(null);
let backdropRef = $state<HTMLDivElement | null>(null);

const isDirty = $derived(draftDescription !== description);

$effect(() => {
    const current = description;
    untrack(() => {
        if (draftDescription === prevDescription || draftDescription === current) {
            draftDescription = current;
        }
        prevDescription = current;
    });
});

$effect(() => {
    return () => {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }
    };
});

useRpcReceiver<CommitDetailsHostToWebviewMessage>(CommitDetailsHostToWebviewMessageSchema, {
    saveFailed: () => {
        isSaving = false;
        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }
    },
    saveComplete: ({ description: savedDescription }) => {
        isSaving = false;
        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }
        draftDescription = savedDescription;
        prevDescription = savedDescription;
    },
    updateDescription: async ({ description: newDesc, selectionStart, selectionEnd }) => {
        isApplyingExtensionEdit = true;
        try {
            draftDescription = newDesc;
            await tick();
            if (textareaRef) {
                textareaRef.focus();
                textareaRef.setSelectionRange(selectionStart ?? 0, selectionEnd ?? 0);
            }
        } finally {
            isApplyingExtensionEdit = false;
        }
    },
    update: () => {},
});

function handleSave() {
    if (isImmutable || isSaving || !isDirty) {
        return;
    }
    isSaving = true;
    onSave(draftDescription);

    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }
    saveTimeout = setTimeout(() => {
        isSaving = false;
    }, 15000);
}

async function handleFormat() {
    const newDescription = await formatCommitDescription(draftDescription, bodyWidthRuler);
    if (newDescription !== draftDescription) {
        draftDescription = newDescription;
        await tick();
        if (textareaRef) {
            textareaRef.focus();
            const len = newDescription.length;
            textareaRef.setSelectionRange(len, len);
            onDescriptionChange?.(newDescription, len, len);
        }
    }
}

function handleInput() {
    if (!isApplyingExtensionEdit && textareaRef) {
        onDescriptionChange?.(draftDescription, textareaRef.selectionStart, textareaRef.selectionEnd);
    }
}

function handleScroll() {
    if (backdropRef && textareaRef) {
        backdropRef.scrollTop = textareaRef.scrollTop;
        backdropRef.scrollLeft = textareaRef.scrollLeft;
    }
}

function handleKeydown(e: KeyboardEvent) {
    const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const hasModifier = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (hasModifier && e.key === 's') {
        e.preventDefault();
        e.stopPropagation();
        handleSave();
    }
}

const lines = $derived(draftDescription.split('\n'));
const title = $derived(lines[0] ?? '');
const bodyLines = $derived(lines.slice(1));

const isTitleOver = $derived(title.length > titleWidthRuler);
const isBodyOver = $derived(bodyLines.some((l) => l.length > bodyWidthRuler));

const titleRulerColor = $derived(
    isTitleOver ? 'var(--vscode-errorForeground)' : 'var(--vscode-editorRuler-foreground)',
);
const bodyRulerColor = $derived(isBodyOver ? 'var(--vscode-errorForeground)' : 'var(--vscode-editorRuler-foreground)');

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const highlightedHtml = $derived.by(() => {
    let html = '';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const limit = i === 0 ? titleWidthRuler : bodyWidthRuler;
        if (line.length > limit) {
            const normal = escapeHtml(line.substring(0, limit));
            const error = escapeHtml(line.substring(limit));
            html += `<span class="highlight-normal">${normal}</span><span class="highlight-error">${error}</span>`;
        } else {
            html += `<span class="highlight-normal">${escapeHtml(line)}</span>`;
        }
        if (i < lines.length - 1) {
            html += '\n';
        }
    }
    if (draftDescription.endsWith('\n')) {
        html += '<br />';
    }
    return html;
});

const isMacPlatform = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
const saveShortcutHint = isMacPlatform ? '⌘S' : 'Ctrl+S';

function getFileIcon(status: string): string {
    switch (status) {
        case 'added':
        case 'copied':
            return 'diff-added';
        case 'deleted':
            return 'diff-removed';
        case 'modified':
            return 'diff-modified';
        case 'renamed':
            return 'diff-renamed';
        default:
            return 'file';
    }
}

function getFileColor(status: string): string {
    switch (status) {
        case 'added':
        case 'copied':
            return 'var(--vscode-gitDecoration-addedResourceForeground)';
        case 'deleted':
            return 'var(--vscode-gitDecoration-deletedResourceForeground)';
        case 'modified':
            return 'var(--vscode-gitDecoration-modifiedResourceForeground)';
        case 'renamed':
            return 'var(--vscode-gitDecoration-renamedResourceForeground)';
        default:
            return 'var(--vscode-foreground)';
    }
}
</script>

<div class="commit-details-container">
    <!-- Header -->
    <div class="header-section">
        <div class="pills-row">
            {#if isImmutable}
                <BasePill
                    className="badge-immutable"
                    title="This commit cannot be modified"
                >
                    <span class="pill-label">Immutable</span>
                </BasePill>
            {/if}
            {#if isEmpty}
                <BasePill
                    className="badge-empty"
                    title="This commit has no file changes"
                >
                    <span class="pill-label">Empty</span>
                </BasePill>
            {/if}
            {#if isConflict}
                <BasePill
                    className="badge-conflicted"
                    title="This commit has unresolved conflicts"
                >
                    <span class="pill-label">Conflicted</span>
                </BasePill>
            {/if}
            {#each bookmarks as b (`${b.name}-${b.remote}`)}
                <BookmarkPill bookmark={b} />
            {/each}
            {#each tags as t (t)}
                <TagPill tag={t} />
            {/each}
        </div>

        <div class="ids-section">
            <div class="id-row">
                <span class="id-label">Change:</span>
                <span class="id-value" title={changeId}>
                    {formatDisplayChangeId(changeId, changeId, minChangeIdLength)}
                </span>
                <button
                    type="button"
                    class="copy-button"
                    onclick={() => navigator.clipboard.writeText(changeId)}
                    title="Copy Change ID"
                >
                    <span class="codicon codicon-copy"></span>
                </button>
            </div>
            <div class="id-row">
                <span class="id-label">Commit:</span>
                <span class="id-value" title={commitId}>
                    {commitId.substring(0, 12)}
                </span>
                <button
                    type="button"
                    class="copy-button"
                    onclick={() => navigator.clipboard.writeText(commitId)}
                    title="Copy Commit ID"
                >
                    <span class="codicon codicon-copy"></span>
                </button>
            </div>

            <PersonInfo person={author} label="Author" />
            <PersonInfo person={committer} label="Committer" />
        </div>
    </div>

    <!-- Description Editor -->
    <div class="editor-section">
        <div class="editor-header">
            <div class="editor-label-group">
                <label for="commit-message" class="editor-label">
                    Message
                </label>
                <a
                    href="command:workbench.action.openSettings?%5B%22jj-view.commit%22%5D"
                    title="Configure width rulers"
                    class="settings-link"
                >
                    <span class="codicon codicon-settings-gear"></span>
                </a>
            </div>
            <div class="editor-actions">
                {#if !isImmutable}
                    <button
                        type="button"
                        onclick={handleFormat}
                        title={`Format body to ${bodyWidthRuler} characters`}
                        class="format-button"
                    >
                        <span class="codicon codicon-word-wrap"></span>
                        Format Body
                    </button>
                    <button
                        type="button"
                        title={`Save Changes (${saveShortcutHint})`}
                        onclick={handleSave}
                        disabled={isSaving || !isDirty}
                        class="save-button"
                        class:btn-dirty={isDirty && !isSaving}
                    ><span class="codicon {isDirty ? 'codicon-save' : 'codicon-check'}"></span>{isSaving
                        ? 'Saving...'
                        : isDirty
                          ? `Save Changes (${saveShortcutHint})`
                          : 'Saved'}</button>
                {/if}
            </div>
        </div>
        <div class="editor-wrapper">
            <div bind:this={backdropRef} class="editor-backdrop">
                <div class="backdrop-content">
                    <div
                        class="ruler title-ruler"
                        style:left={`calc(10px + ${titleWidthRuler}ch)`}
                        style:background-color={titleRulerColor}
                    ></div>
                    <div
                        class="ruler body-ruler"
                        style:left={`calc(10px + ${bodyWidthRuler}ch)`}
                        style:background-color={bodyRulerColor}
                    ></div>
                    <div class="backdrop-text">{@html highlightedHtml}</div>
                </div>
            </div>
            <textarea
                id="commit-message"
                class="commit-textarea"
                bind:this={textareaRef}
                bind:value={draftDescription}
                disabled={isImmutable}
                oninput={handleInput}
                onscroll={handleScroll}
                onkeydown={handleKeydown}
            ></textarea>
        </div>
    </div>

    <!-- Changed Files -->
    <div class="files-section">
        <div class="files-header">
            <div class="files-title-group">
                <h3 class="files-title">
                    Changed Files ({files.length})
                </h3>
                <span class="diff-stats">
                    <span class="stat-added">
                        +{files.reduce((acc, f) => acc + (f.additions || 0), 0)}
                    </span>
                    <span class="stat-divider">/</span>
                    <span class="stat-deleted">
                        -{files.reduce((acc, f) => acc + (f.deletions || 0), 0)}
                    </span>
                </span>
            </div>
            <button
                type="button"
                onclick={onOpenMultiDiff}
                class="multi-diff-button"
            >
                <span class="codicon codicon-diff"></span>
                Multi-file Diff
            </button>
        </div>
        <div class="files-list">
            {#if files.length === 0}
                <div class="no-files-message">
                    No changed files.
                </div>
            {:else}
                {#each files as file (file.path)}
                    <button
                        type="button"
                        class="file-row"
                        onclick={() => onOpenDiff($state.snapshot(file), isImmutable)}
                        onkeydown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onOpenDiff($state.snapshot(file), isImmutable);
                            }
                        }}
                    >
                        <span
                            class="codicon codicon-{getFileIcon(file.status)} file-icon"
                            style:color={getFileColor(file.status)}
                        ></span>
                        <span class="file-path" title={file.path}>
                            {file.path}
                        </span>
                        <span class="file-status-group">
                            {#if file.additions !== undefined || file.deletions !== undefined}
                                <span class="file-diff-stats">
                                    <span class="stat-added">+{file.additions || 0}</span>
                                    <span class="stat-divider">/</span>
                                    <span class="stat-deleted">-{file.deletions || 0}</span>
                                </span>
                            {/if}
                            <span class="file-status-label">{file.status}</span>
                        </span>
                    </button>
                {/each}
            {/if}
        </div>
    </div>
</div>

<style>
    .commit-details-container {
        display: flex;
        flex-direction: column;
        height: 100vh;
        padding: 20px;
        box-sizing: border-box;
        background-color: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-editor-font-family);
    }

    .header-section {
        margin-bottom: 12px;
    }

    .pills-row {
        margin: 0 0 10px 0;
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        align-items: center;
        font-size: 11px;
        font-weight: normal;
    }

    :global(.badge-immutable) {
        border: 1px solid color-mix(in srgb, var(--vscode-gitDecoration-untrackedResourceForeground), transparent 50%) !important;
        background-color: color-mix(in srgb, var(--vscode-gitDecoration-untrackedResourceForeground), transparent 90%) !important;
        color: var(--vscode-gitDecoration-untrackedResourceForeground) !important;
        text-transform: uppercase;
        font-weight: bold;
    }

    :global(.badge-empty) {
        border: 1px solid color-mix(in srgb, var(--vscode-gitDecoration-ignoredResourceForeground), transparent 50%) !important;
        background-color: color-mix(in srgb, var(--vscode-gitDecoration-ignoredResourceForeground), transparent 90%) !important;
        color: var(--vscode-gitDecoration-ignoredResourceForeground) !important;
        text-transform: uppercase;
        font-weight: bold;
    }

    :global(.badge-conflicted) {
        border: 1px solid color-mix(in srgb, var(--vscode-gitDecoration-conflictingResourceForeground), transparent 50%) !important;
        background-color: color-mix(in srgb, var(--vscode-gitDecoration-conflictingResourceForeground), transparent 90%) !important;
        color: var(--vscode-gitDecoration-conflictingResourceForeground) !important;
        text-transform: uppercase;
        font-weight: bold;
    }

    .ids-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .id-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .id-label {
        font-size: 13px;
        color: var(--vscode-descriptionForeground);
    }

    .id-value {
        font-size: 13px;
        color: var(--vscode-foreground);
        font-family: monospace;
    }

    .copy-button {
        background: none;
        border: none;
        padding: 2px;
        cursor: pointer;
        color: var(--vscode-icon-foreground);
        display: flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
    }

    .copy-button .codicon {
        font-size: 14px;
    }

    .editor-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 20px;
        flex: 1;
    }

    .editor-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
    }

    .editor-label-group {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .editor-label {
        font-weight: bold;
    }

    .settings-link {
        font-size: 11px;
        color: var(--vscode-textLink-foreground);
        text-decoration: none;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        width: 14px;
        height: 14px;
    }

    .editor-actions {
        display: flex;
        gap: 8px;
    }

    .format-button {
        background: none;
        border: none;
        padding: 2px 4px;
        cursor: pointer;
        color: var(--vscode-textLink-foreground);
        display: flex;
        align-items: center;
        font-size: 12px;
        gap: 4px;
    }

    .save-button {
        padding: 2px 8px;
        color: var(--vscode-button-foreground);
        background-color: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background));
        border: 1px solid transparent;
        cursor: default;
        opacity: 0.6;
        display: flex;
        align-items: center;
        font-size: 12px;
        gap: 4px;
        border-radius: 2px;
        transition: background-color 0.2s, color 0.2s;
    }

    .save-button.btn-dirty {
        cursor: pointer;
        opacity: 1;
        background-color: var(--vscode-button-background);
    }

    .save-button:disabled {
        opacity: 0.7;
        cursor: default;
    }

    .save-button.btn-dirty:not(:disabled) {
        opacity: 1;
        cursor: pointer;
    }

    .btn-dirty :global(.codicon-save) {
        animation: jiggle-icon 2s infinite ease-in-out;
        display: inline-block;
        transform-origin: center;
    }

    @keyframes jiggle-icon {
        0%, 65%, 100% { transform: rotate(0deg); }
        70% { transform: rotate(12deg); }
        77% { transform: rotate(-8deg); }
        84% { transform: rotate(4deg); }
        91% { transform: rotate(-2deg); }
        98% { transform: rotate(0deg); }
    }

    .editor-wrapper {
        position: relative;
        flex: 1;
        display: flex;
        background-color: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border);
        font-family: var(--vscode-editor-font-family), monospace;
        font-size: var(--vscode-editor-font-size);
        line-height: 1.5em;
        min-height: 150px;
        overflow: hidden;
    }

    .editor-backdrop {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        overflow: hidden;
        pointer-events: none;
        z-index: 1;
    }

    .backdrop-content {
        position: relative;
        min-width: 100%;
        min-height: 100%;
        padding: 10px;
        box-sizing: border-box;
        color: var(--vscode-input-foreground);
    }

    .ruler {
        position: absolute;
        width: 1px;
        pointer-events: none;
        z-index: 1;
    }

    .title-ruler {
        top: 10px;
        bottom: auto;
        height: 1.5em;
    }

    .body-ruler {
        top: calc(10px + 1.5em);
        bottom: 10px;
    }

    .backdrop-text {
        position: relative;
        z-index: 2;
        white-space: pre;
        overflow-wrap: normal;
        font-family: inherit;
        font-size: inherit;
        line-height: inherit;
        tab-size: 4;
    }

    .backdrop-text :global(.highlight-normal) {
        background-color: var(--vscode-input-background);
    }

    .backdrop-text :global(.highlight-error) {
        color: var(--vscode-errorForeground);
        background-color: var(--vscode-input-background);
    }

    .commit-textarea {
        flex: 1;
        margin: 0;
        box-sizing: border-box;
        background-color: transparent;
        color: transparent;
        caret-color: var(--vscode-input-foreground);
        border: none;
        padding: 10px;
        resize: none;
        outline: none;
        font-family: inherit;
        font-size: inherit;
        line-height: inherit;
        z-index: 2;
        white-space: pre;
        overflow-wrap: normal;
        overflow-x: auto;
        tab-size: 4;
    }

    .commit-textarea::selection {
        color: var(--vscode-input-foreground) !important;
        background-color: var(--vscode-editor-selectionBackground) !important;
    }

    .files-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex: 1;
        max-height: 40%;
    }

    .files-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .files-title-group {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .files-title {
        font-weight: bold;
        margin: 0;
        font-size: inherit;
    }

    .diff-stats {
        font-size: 11px;
        font-family: monospace;
    }

    .stat-added {
        color: var(--vscode-gitDecoration-addedResourceForeground);
    }

    .stat-divider {
        margin: 0 4px;
        opacity: 0.5;
    }

    .stat-deleted {
        color: var(--vscode-gitDecoration-deletedResourceForeground);
    }

    .multi-diff-button {
        padding: 2px 8px;
        color: var(--vscode-button-foreground);
        background-color: var(--vscode-button-secondaryBackground);
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        font-size: 12px;
        gap: 4px;
        border-radius: 2px;
    }

    .files-list {
        flex: 1;
        border: 1px solid var(--vscode-widget-border);
        overflow-y: auto;
    }

    .no-files-message {
        padding: 10px;
        color: var(--vscode-descriptionForeground);
        font-style: italic;
    }

    .file-row {
        display: flex;
        align-items: center;
        padding: 6px 10px;
        font-size: 13px;
        cursor: pointer;
        border-bottom: 1px solid var(--vscode-tree-tableOddRowsBackground);
        width: 100%;
        background: none;
        border: none;
        color: inherit;
        text-align: left;
    }

    .file-row:hover {
        background-color: var(--vscode-list-hoverBackground);
    }

    .file-icon {
        margin-right: 8px;
    }

    .file-path {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .file-status-group {
        margin-left: auto;
        font-size: 11px;
        display: flex;
        gap: 8px;
        color: var(--vscode-descriptionForeground);
    }

    .file-diff-stats {
        font-family: monospace;
    }

    .file-status-label {
        min-width: 60px;
        text-align: right;
    }
</style>
