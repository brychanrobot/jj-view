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

let containerHeight = $state(0);
let topSectionHeight = $state(0);
let editorHeaderHeight = $state(0);
let backdropTextHeight = $state(0);
let filesHeaderHeight = $state(0);
let filesContentHeight = $state(0);

const SECTION_GAP = 16;
const CONTAINER_PADDING_Y = 36;
const MIN_EDITOR_WRAPPER = 96;
const MIN_FILES_LIST = 36;

const editorWrapperNeeded = $derived(Math.max(MIN_EDITOR_WRAPPER, (backdropTextHeight || 0) + 28));
const filesListNeeded = $derived(Math.max(MIN_FILES_LIST, (filesContentHeight || 0) + 4));

const editorSectionNeeded = $derived(editorWrapperNeeded + (editorHeaderHeight || 26) + 8);
const filesSectionNeeded = $derived(filesListNeeded + (filesHeaderHeight || 26) + 8);

const availableContentHeight = $derived(
    Math.max(
        MIN_EDITOR_WRAPPER + MIN_FILES_LIST + 70,
        containerHeight - topSectionHeight - CONTAINER_PADDING_Y - SECTION_GAP * 2,
    ),
);

const layoutAllocation = $derived.by(() => {
    const avail = availableContentHeight;
    const half = avail / 2;
    const edNeeded = editorSectionNeeded;
    const flNeeded = filesSectionNeeded;

    if (edNeeded + flNeeded <= avail) {
        return {
            editorHeight: edNeeded,
            filesHeight: flNeeded,
        };
    }

    if (edNeeded <= half) {
        return {
            editorHeight: edNeeded,
            filesHeight: avail - edNeeded,
        };
    }

    if (flNeeded <= half) {
        return {
            editorHeight: avail - flNeeded,
            filesHeight: flNeeded,
        };
    }

    return {
        editorHeight: half,
        filesHeight: half,
    };
});

let copiedId = $state<'change' | 'commit' | null>(null);
let copyTimeout: ReturnType<typeof setTimeout> | null = null;

function copyToClipboard(text: string, id: 'change' | 'commit') {
    if (navigator.clipboard) {
        navigator.clipboard
            .writeText(text)
            .then(() => {
                copiedId = id;
                if (copyTimeout) {
                    clearTimeout(copyTimeout);
                }
                copyTimeout = setTimeout(() => {
                    copiedId = null;
                }, 1500);
            })
            .catch(() => {});
    }
}

function splitFilePath(filePath: string): { dir: string; name: string } {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash === -1) {
        return { dir: '', name: filePath };
    }
    return {
        dir: filePath.slice(0, lastSlash + 1),
        name: filePath.slice(lastSlash + 1),
    };
}

const totalAdditions = $derived(files.reduce((acc, f) => acc + (f.additions || 0), 0));
const totalDeletions = $derived(files.reduce((acc, f) => acc + (f.deletions || 0), 0));

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
        if (copyTimeout) {
            clearTimeout(copyTimeout);
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
    isTitleOver
        ? 'var(--vscode-errorForeground)'
        : 'var(--vscode-editorRuler-foreground, color-mix(in srgb, var(--vscode-editor-foreground, #cccccc), transparent 75%))',
);
const bodyRulerColor = $derived(
    isBodyOver
        ? 'var(--vscode-errorForeground)'
        : 'var(--vscode-editorRuler-foreground, color-mix(in srgb, var(--vscode-editor-foreground, #cccccc), transparent 75%))',
);

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

<div class="commit-details-container" bind:clientHeight={containerHeight}>
    <!-- Top Section (Status Badges + Metadata) -->
    <div class="top-section" bind:clientHeight={topSectionHeight}>
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

        <div class="metadata-section">
            <div class="id-chips-row">
                <div class="id-row">
                    <span class="id-label">Change:</span>
                    <span class="id-value" title={changeId}>
                        {formatDisplayChangeId(changeId, changeId, minChangeIdLength)}
                    </span>
                    <button
                        type="button"
                        class="copy-button"
                        onclick={() => copyToClipboard(changeId, 'change')}
                        title="Copy Change ID"
                    >
                        <span class="codicon {copiedId === 'change' ? 'codicon-check copied-icon' : 'codicon-copy'}"></span>
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
                        onclick={() => copyToClipboard(commitId, 'commit')}
                        title="Copy Commit ID"
                    >
                        <span class="codicon {copiedId === 'commit' ? 'codicon-check copied-icon' : 'codicon-copy'}"></span>
                    </button>
                </div>
            </div>

            {#if author || committer}
                <div class="people-rows">
                    <PersonInfo person={author} label="Author" />
                    <PersonInfo person={committer} label="Committer" />
                </div>
            {/if}
        </div>
    </div>

    <!-- Description Editor Section -->
    <div
        class="section editor-section"
        style:height={containerHeight > 0 ? `${layoutAllocation.editorHeight}px` : undefined}
    >
        <div class="section-header" bind:clientHeight={editorHeaderHeight}>
            <div class="section-title-group">
                <label for="commit-message" class="section-title">
                    Message
                </label>
                <span class="ruler-indicator" title="Configured rulers for title / body width">
                    {titleWidthRuler}/{bodyWidthRuler} ch
                </span>
                <a
                    href="command:workbench.action.openSettings?%5B%22jj-view.commit%22%5D"
                    title="Configure width rulers"
                    class="settings-icon-btn"
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
                        class="secondary-button"
                    >
                        <span class="codicon codicon-word-wrap"></span>
                        Format Body
                    </button>
                    <button
                        type="button"
                        title={`Save Changes (${saveShortcutHint})`}
                        onclick={handleSave}
                        disabled={isSaving || !isDirty}
                        class="primary-button"
                        class:btn-dirty={isDirty && !isSaving}
                    >{isSaving
                        ? 'Saving...'
                        : isDirty
                          ? `Save Changes (${saveShortcutHint})`
                          : 'Saved'}</button>
                {:else}
                    <span class="read-only-chip">
                        <span class="codicon codicon-lock"></span>
                        Read-only
                    </span>
                {/if}
            </div>
        </div>
        <div
            class="editor-wrapper"
            class:is-immutable={isImmutable}
        >
            <div bind:this={backdropRef} class="editor-backdrop">
                <div class="backdrop-content">
                    <div
                        class="ruler title-ruler"
                        style:left={`calc(12px + ${titleWidthRuler}ch)`}
                        style:background-color={titleRulerColor}
                    ></div>
                    <div
                        class="ruler body-ruler"
                        style:left={`calc(12px + ${bodyWidthRuler}ch)`}
                        style:background-color={bodyRulerColor}
                    ></div>
                    <div class="backdrop-text" bind:clientHeight={backdropTextHeight}>{@html highlightedHtml}</div>
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

    <!-- Changed Files Section -->
    <div
        class="section files-section"
        style:height={containerHeight > 0 ? `${layoutAllocation.filesHeight}px` : undefined}
    >
        <div class="section-header files-header" bind:clientHeight={filesHeaderHeight}>
            <div class="section-title-group">
                <h3 class="section-title">
                    Changed Files ({files.length})
                </h3>
                {#if totalAdditions > 0 || totalDeletions > 0}
                    <div class="diff-summary-badges">
                        {#if totalAdditions > 0}
                            <span class="stat-pill stat-added">+{totalAdditions}</span>
                        {/if}
                        {#if totalDeletions > 0}
                            <span class="stat-pill stat-deleted">-{totalDeletions}</span>
                        {/if}
                    </div>
                {/if}
            </div>
            <button
                type="button"
                onclick={onOpenMultiDiff}
                class="secondary-button"
            >
                <span class="codicon codicon-diff"></span>
                Multi-file Diff
            </button>
        </div>
        <div class="files-list">
            <div class="files-items" bind:clientHeight={filesContentHeight}>
                {#if files.length === 0}
                    <div class="no-files-message">
                        <span class="codicon codicon-check-all"></span>
                        No changed files.
                    </div>
                {:else}
                    {#each files as file (file.path)}
                        {@const { dir, name } = splitFilePath(file.path)}
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
                            <span class="file-path-container" title={file.path}>
                                {#if dir}
                                    <span class="file-dir">{dir}</span>
                                {/if}
                                <span class="file-name">{name}</span>
                            </span>
                            <span class="file-meta-group">
                                {#if file.additions !== undefined || file.deletions !== undefined}
                                    <span class="file-diff-stats">
                                        {#if (file.additions ?? 0) > 0}
                                            <span class="stat-added">+{file.additions}</span>
                                        {/if}
                                        {#if (file.deletions ?? 0) > 0}
                                            <span class="stat-deleted">-{file.deletions}</span>
                                        {/if}
                                    </span>
                                {/if}
                                <span class="file-status-badge status-{file.status}">{file.status}</span>
                                <span class="diff-hover-icon codicon codicon-git-compare" title="Open diff"></span>
                            </span>
                        </button>
                    {/each}
                {/if}
            </div>
        </div>
    </div>
</div>

<style>
    :global(html, body) {
        height: 100%;
        margin: 0;
        padding: 0;
        overflow: hidden;
    }

    :global(#root) {
        height: 100%;
    }

    .commit-details-container {
        display: flex;
        flex-direction: column;
        gap: 16px;
        height: 100vh;
        max-height: 100vh;
        padding: 16px 20px 20px;
        box-sizing: border-box;
        background-color: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-font-family);
        overflow: hidden;
    }

    .top-section {
        display: flex;
        flex-direction: column;
        gap: 16px;
        flex-shrink: 0;
    }

    /* Sections */
    .section {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        min-height: 26px;
    }

    .section-title-group {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .section-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        color: var(--vscode-descriptionForeground);
        margin: 0;
    }

    /* Top Pills Row */
    .pills-row {
        margin: 0;
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        align-items: center;
        font-size: 11px;
        font-weight: normal;
    }

    :global(.badge-immutable) {
        border: 1px solid color-mix(in srgb, var(--vscode-gitDecoration-untrackedResourceForeground), transparent 40%) !important;
        background-color: color-mix(in srgb, var(--vscode-gitDecoration-untrackedResourceForeground), transparent 88%) !important;
        color: var(--vscode-gitDecoration-untrackedResourceForeground) !important;
        text-transform: uppercase;
        font-weight: 700;
    }

    :global(.badge-empty) {
        border: 1px solid color-mix(in srgb, var(--vscode-gitDecoration-ignoredResourceForeground), transparent 40%) !important;
        background-color: color-mix(in srgb, var(--vscode-gitDecoration-ignoredResourceForeground), transparent 88%) !important;
        color: var(--vscode-gitDecoration-ignoredResourceForeground) !important;
        text-transform: uppercase;
        font-weight: 700;
    }

    :global(.badge-conflicted) {
        border: 1px solid color-mix(in srgb, var(--vscode-gitDecoration-conflictingResourceForeground), transparent 40%) !important;
        background-color: color-mix(in srgb, var(--vscode-gitDecoration-conflictingResourceForeground), transparent 88%) !important;
        color: var(--vscode-gitDecoration-conflictingResourceForeground) !important;
        text-transform: uppercase;
        font-weight: 700;
    }

    /* Metadata Section */
    .metadata-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .id-chips-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
    }

    .id-row {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: color-mix(in srgb, var(--vscode-editor-background), var(--vscode-foreground) 3.5%);
        border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground), transparent 86%);
        border-radius: 6px;
        padding: 3px 6px 3px 8px;
        font-size: 12px;
        transition: border-color 0.15s, background-color 0.15s;
    }

    .id-row:hover {
        border-color: color-mix(in srgb, var(--vscode-editor-foreground), transparent 72%);
    }

    .id-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
    }

    .id-value {
        font-family: var(--vscode-editor-font-family), monospace;
        font-size: 12px;
        color: var(--vscode-foreground);
    }

    .copy-button {
        background: transparent;
        border: none;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        padding: 2px 4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        transition: background-color 0.15s, color 0.15s;
    }

    .copy-button:hover {
        background-color: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
        color: var(--vscode-foreground);
    }

    .copy-button .codicon {
        font-size: 12px;
    }

    :global(.copied-icon) {
        color: var(--vscode-gitDecoration-addedResourceForeground, #23d18b) !important;
    }

    .people-rows {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    /* Message Editor Section */
    .editor-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .ruler-indicator {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        background: color-mix(in srgb, var(--vscode-editor-foreground), transparent 92%);
        padding: 1px 6px;
        border-radius: 10px;
        font-family: var(--vscode-editor-font-family), monospace;
    }

    .settings-icon-btn {
        color: var(--vscode-descriptionForeground);
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 4px;
        text-decoration: none;
        transition: background-color 0.15s, color 0.15s;
    }

    .settings-icon-btn:hover {
        background-color: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
        color: var(--vscode-foreground);
    }

    .settings-icon-btn .codicon {
        font-size: 14px;
    }

    .editor-actions {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    /* Buttons */
    .primary-button {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: 1px solid var(--vscode-button-border, transparent);
        padding: 3px 10px;
        font-size: 12px;
        font-weight: 500;
        border-radius: 6px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        line-height: normal;
        transition: background-color 0.15s, opacity 0.15s;
    }

    .primary-button:hover:not(:disabled) {
        background-color: var(--vscode-button-hoverBackground);
    }

    .primary-button:disabled {
        opacity: 0.6;
        cursor: default;
    }

    .primary-button.btn-dirty:not(:disabled) {
        box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4);
    }

    .primary-button.btn-dirty :global(.codicon-save) {
        animation: jiggle-icon 3s ease-in-out infinite;
    }

    .secondary-button {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: 1px solid var(--vscode-button-border, transparent);
        padding: 3px 10px;
        font-size: 12px;
        font-weight: 500;
        border-radius: 6px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        line-height: normal;
        transition: background-color 0.15s;
    }

    .secondary-button:hover {
        background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .read-only-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        background: color-mix(in srgb, var(--vscode-editor-foreground), transparent 92%);
        padding: 2px 8px;
        border-radius: 10px;
    }

    @keyframes jiggle-icon {
        0%, 65%, 100% { transform: rotate(0deg); }
        70% { transform: rotate(12deg); }
        77% { transform: rotate(-8deg); }
        84% { transform: rotate(4deg); }
        91% { transform: rotate(-2deg); }
        98% { transform: rotate(0deg); }
    }

    /* Editor Wrapper */
    .editor-wrapper {
        position: relative;
        flex: 1;
        min-height: 0;
        display: flex;
        background-color: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, color-mix(in srgb, var(--vscode-editor-foreground), transparent 82%));
        border-radius: 8px;
        font-family: var(--vscode-editor-font-family), monospace;
        font-size: var(--vscode-editor-font-size, 13px);
        line-height: 1.5em;
        overflow: hidden;
        transition: border-color 0.15s, box-shadow 0.15s;
    }

    .editor-wrapper:focus-within {
        border-color: var(--vscode-focusBorder, #007fd4);
        box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4);
    }

    .editor-wrapper.is-immutable {
        opacity: 0.9;
        background-color: color-mix(in srgb, var(--vscode-input-background), transparent 20%);
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
        padding: 12px;
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
        top: 12px;
        bottom: auto;
        height: 1.5em;
    }

    .body-ruler {
        top: calc(12px + 1.5em);
        bottom: 12px;
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
        height: 100%;
        margin: 0;
        box-sizing: border-box;
        background-color: transparent;
        color: transparent;
        caret-color: var(--vscode-input-foreground);
        border: none;
        padding: 12px;
        resize: none;
        outline: none;
        font-family: inherit;
        font-size: inherit;
        line-height: inherit;
        z-index: 2;
        white-space: pre;
        overflow-wrap: normal;
        overflow-y: auto;
        overflow-x: auto;
        tab-size: 4;
    }

    .commit-textarea::-webkit-resizer {
        display: none !important;
        background: transparent !important;
    }

    .commit-textarea::selection {
        color: var(--vscode-input-foreground) !important;
        background-color: var(--vscode-editor-selectionBackground) !important;
    }

    /* Changed Files Section */
    .files-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .diff-summary-badges {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-family: var(--vscode-editor-font-family), monospace;
    }

    .stat-pill {
        padding: 1px 6px;
        border-radius: 10px;
        font-size: 11px;
        font-weight: 700;
        line-height: normal;
    }

    .stat-added {
        color: var(--vscode-gitDecoration-addedResourceForeground, #23d18b);
        background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #23d18b) 14%, transparent);
    }

    .stat-deleted {
        color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c);
        background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c) 14%, transparent);
    }

    .files-list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
    }

    .files-items {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .file-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        background: transparent;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        text-align: left;
        width: 100%;
        color: inherit;
        font-family: inherit;
        font-size: 13px;
        transition: background-color 0.12s ease;
    }

    .file-row:hover {
        background-color: var(--vscode-list-hoverBackground);
    }

    .file-row:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        background-color: var(--vscode-list-focusBackground, var(--vscode-list-hoverBackground));
    }

    .file-icon {
        font-size: 15px;
        flex-shrink: 0;
    }

    .file-path-container {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        display: flex;
        align-items: baseline;
    }

    .file-dir {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
    }

    .file-name {
        color: var(--vscode-foreground);
        font-weight: 500;
    }

    .file-meta-group {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
        flex-shrink: 0;
    }

    .file-diff-stats {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        font-family: var(--vscode-editor-font-family), monospace;
    }

    .file-status-badge {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 1px 6px;
        border-radius: 10px;
        line-height: normal;
    }

    .file-status-badge.status-added,
    .file-status-badge.status-copied {
        color: var(--vscode-gitDecoration-addedResourceForeground, #23d18b);
        background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #23d18b) 12%, transparent);
    }

    .file-status-badge.status-modified {
        color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
        background: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d) 12%, transparent);
    }

    .file-status-badge.status-deleted {
        color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c);
        background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c) 12%, transparent);
    }

    .file-status-badge.status-renamed {
        color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991);
        background: color-mix(in srgb, var(--vscode-gitDecoration-renamedResourceForeground, #73c991) 12%, transparent);
    }

    .diff-hover-icon {
        opacity: 0;
        font-size: 14px;
        color: var(--vscode-descriptionForeground);
        transition: opacity 0.15s, color 0.15s;
    }

    .file-row:hover .diff-hover-icon {
        opacity: 0.85;
    }

    .diff-hover-icon:hover {
        color: var(--vscode-foreground);
    }

    .no-files-message {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        padding: 12px 10px;
        font-style: italic;
    }
</style>
