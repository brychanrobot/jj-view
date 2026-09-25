<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { FileDiff } from '@pierre/diffs';
import { Editor } from '@pierre/diffs/edit';
import { onDestroy, onMount, untrack } from 'svelte';
import { isBinaryFile } from './binary-detection';

interface Props {
    filename: string;
    originalContent?: string;
    modifiedContent?: string;
    isWorkingCopy?: boolean;
    isConflict?: boolean;
    onSave?: (newContent: string) => Promise<void> | void;
    onDiscard?: () => Promise<void> | void;
    onResolveConflict?: () => Promise<void> | void;
}

let {
    filename,
    originalContent = '',
    modifiedContent = '',
    isWorkingCopy = false,
    isConflict = false,
    onSave,
    onDiscard,
    onResolveConflict,
}: Props = $props();

let containerEl: HTMLDivElement | null = $state(null);
let diffStyle: 'split' | 'unified' = $state('split');
let isDirty = $state(false);
let isSaving = $state(false);
let saveMessage = $state<string | null>(null);
let canUndo = $state(false);
let canRedo = $state(false);
let currentContent = $state('');

let fileDiffInstance: FileDiff | null = null;
let editorInstance: Editor<'file-diff'> | null = null;
let detachEditor: (() => void) | null = null;
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let saveMessageTimer: ReturnType<typeof setTimeout> | null = null;

const isBinary = $derived(isBinaryFile(filename, modifiedContent) || isBinaryFile(filename, originalContent));

function cleanupInstances(): void {
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
        if (isDirty && onSave && !isSaving) {
            void onSave(currentContent);
        }
    }
    if (saveMessageTimer) {
        clearTimeout(saveMessageTimer);
        saveMessageTimer = null;
    }
    if (detachEditor) {
        detachEditor();
        detachEditor = null;
    }
    if (editorInstance) {
        try {
            (editorInstance as { cleanUp?: () => void }).cleanUp?.();
        } catch {
            // Ignore cleanup failure
        }
        editorInstance = null;
    }
    if (fileDiffInstance) {
        fileDiffInstance.cleanUp();
        fileDiffInstance = null;
    }
}

async function handleSave(): Promise<void> {
    if (!onSave || isSaving || !isDirty) {
        return;
    }

    const savingContent = currentContent;
    try {
        isSaving = true;
        saveMessage = 'Saving...';
        await onSave(savingContent);
        if (currentContent === savingContent) {
            isDirty = false;
        }
        saveMessage = 'Saved';
        if (saveMessageTimer) {
            clearTimeout(saveMessageTimer);
        }
        saveMessageTimer = setTimeout(() => {
            if (saveMessage === 'Saved') {
                saveMessage = null;
            }
        }, 2000);
    } catch {
        saveMessage = 'Failed to save';
    } finally {
        isSaving = false;
    }
}

async function handleDiscard(): Promise<void> {
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
    }
    isDirty = false;
    currentContent = originalContent;
    if (onDiscard) {
        await onDiscard();
    }
    renderDiff();
}

async function handleResolveConflict(): Promise<void> {
    if (isDirty) {
        await handleSave();
    }
    if (onResolveConflict) {
        await onResolveConflict();
    }
}

function scheduleAutoSave(): void {
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
    }
    saveDebounceTimer = setTimeout(() => {
        handleSave();
    }, 750);
}

function renderDiff(): void {
    if (!containerEl || isBinary || typeof window === 'undefined') {
        return;
    }

    cleanupInstances();
    containerEl.innerHTML = '';

    fileDiffInstance = new FileDiff({
        diffStyle,
        expandUnchanged: false,
    });

    const contentToRender = untrack(() => currentContent);

    fileDiffInstance.render({
        fileContainer: containerEl,
        oldFile: { name: filename, contents: originalContent },
        newFile: { name: filename, contents: contentToRender },
    });

    if (isWorkingCopy) {
        try {
            editorInstance = new Editor<'file-diff'>('file-diff', {
                onChange: () => {
                    if (editorInstance) {
                        currentContent = editorInstance.getText();
                        isDirty = true;
                        canUndo = editorInstance.canUndo;
                        canRedo = editorInstance.canRedo;
                        scheduleAutoSave();
                    }
                },
            });
            detachEditor = editorInstance.edit(fileDiffInstance);
        } catch {
            // Fallback gracefully in testing or headless environments
        }
    }
}

function handleUndo(): void {
    if (editorInstance?.canUndo) {
        editorInstance.undo();
        canUndo = editorInstance.canUndo;
        canRedo = editorInstance.canRedo;
    }
}

function handleRedo(): void {
    if (editorInstance?.canRedo) {
        editorInstance.redo();
        canUndo = editorInstance.canUndo;
        canRedo = editorInstance.canRedo;
    }
}

function handleKeyDown(e: KeyboardEvent): void {
    if (!isWorkingCopy || !onSave) {
        return;
    }
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
    }

    const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    const modKey = isMac ? e.metaKey : e.ctrlKey;

    if (modKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        handleSave();
    }
}

// Synchronize current content when incoming props change
$effect(() => {
    currentContent = modifiedContent;
    isDirty = false;
    canUndo = false;
    canRedo = false;
});

// Re-render when filename, content, diffStyle, or mode change
$effect(() => {
    // Explicitly track these props
    void filename;
    void originalContent;
    void modifiedContent;
    void diffStyle;
    void isWorkingCopy;

    renderDiff();
});

onMount(() => {
    if (typeof window !== 'undefined') {
        window.addEventListener('keydown', handleKeyDown);
    }
});

onDestroy(() => {
    if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', handleKeyDown);
    }
    cleanupInstances();
});
</script>

<div class="pierre-diff-viewer" data-testid="pierre-diff-viewer">
    <div class="diff-toolbar" data-testid="diff-toolbar">
        <div class="toolbar-left">
            <span class="file-name" title={filename}>{filename}</span>
            {#if isDirty}
                <span class="dirty-indicator" title="Unsaved changes">●</span>
            {/if}
            {#if saveMessage}
                <span class="save-status">{saveMessage}</span>
            {/if}
        </div>

        <div class="toolbar-right">
            <div class="diff-style-toggle" role="group" aria-label="Diff style">
                <button
                    type="button"
                    class="toggle-btn"
                    class:active={diffStyle === 'split'}
                    onclick={() => {
                        diffStyle = 'split';
                    }}
                    title="Side-by-side split diff"
                    data-testid="toggle-split-diff"
                >
                    Split
                </button>
                <button
                    type="button"
                    class="toggle-btn"
                    class:active={diffStyle === 'unified'}
                    onclick={() => {
                        diffStyle = 'unified';
                    }}
                    title="Inline unified diff"
                    data-testid="toggle-unified-diff"
                >
                    Unified
                </button>
            </div>

            {#if isWorkingCopy}
                <div class="edit-actions">
                    <button
                        type="button"
                        class="toolbar-btn"
                        onclick={handleUndo}
                        disabled={!canUndo}
                        title="Undo (Ctrl+Z)"
                        data-testid="diff-undo-btn"
                    >
                        <i class="codicon codicon-discard" aria-hidden="true"></i>
                    </button>
                    <button
                        type="button"
                        class="toolbar-btn"
                        onclick={handleRedo}
                        disabled={!canRedo}
                        title="Redo (Ctrl+Y)"
                        data-testid="diff-redo-btn"
                    >
                        <i class="codicon codicon-redo" aria-hidden="true"></i>
                    </button>
                    <button
                        type="button"
                        class="toolbar-btn primary"
                        onclick={handleSave}
                        disabled={!isDirty || isSaving}
                        title="Save changes (Ctrl+S)"
                        data-testid="diff-save-btn"
                    >
                        <i class="codicon codicon-save" aria-hidden="true"></i>
                        <span>Save</span>
                    </button>
                    {#if onDiscard}
                        <button
                            type="button"
                            class="toolbar-btn danger"
                            onclick={handleDiscard}
                            title="Discard file changes"
                            data-testid="diff-discard-btn"
                        >
                            <i class="codicon codicon-trash" aria-hidden="true"></i>
                            <span>Discard</span>
                        </button>
                    {/if}
                </div>
            {/if}

            {#if isConflict && onResolveConflict}
                <button
                    type="button"
                    class="toolbar-btn resolve-btn"
                    onclick={handleResolveConflict}
                    title="Mark conflict as resolved"
                    data-testid="diff-resolve-conflict-btn"
                >
                    <i class="codicon codicon-check" aria-hidden="true"></i>
                    <span>Mark Resolved</span>
                </button>
            {/if}
        </div>
    </div>

    {#if isBinary}
        <div class="binary-card" data-testid="binary-diff-card">
            <i class="codicon codicon-file-binary binary-icon" aria-hidden="true"></i>
            <h3>Binary file not shown</h3>
            <p class="binary-filename">{filename}</p>
            <p class="binary-description">
                The file cannot be displayed in the text diff viewer.
            </p>
        </div>
    {:else}
        <div
            bind:this={containerEl}
            class="diff-content-container"
            data-testid="diff-content-container"
        ></div>
    {/if}
</div>

<style>
.pierre-diff-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background-color: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #cccccc);
    overflow: hidden;
}

.diff-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 35px;
    padding: 0 16px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground, #252526);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, rgba(128, 128, 128, 0.2));
    font-size: 12px;
    flex-shrink: 0;
}

.toolbar-left {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
}

.file-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.dirty-indicator {
    color: var(--vscode-editorOverviewRuler-modifiedForeground, #007fd4);
    font-size: 14px;
}

.save-status {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888888);
}

.toolbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
}

.diff-style-toggle {
    display: inline-flex;
    border-radius: 3px;
    overflow: hidden;
    border: 1px solid var(--vscode-button-secondaryBorder, rgba(128, 128, 128, 0.3));
}

.toggle-btn {
    background-color: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ffffff);
    border: none;
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
}

.toggle-btn.active {
    background-color: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    font-weight: 600;
}

.edit-actions {
    display: flex;
    align-items: center;
    gap: 6px;
}

.toolbar-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background-color: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ffffff);
    border: none;
    border-radius: 2px;
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
}

.toolbar-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.toolbar-btn.primary {
    background-color: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
}

.toolbar-btn.danger {
    background-color: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: #ffffff;
}

.toolbar-btn.resolve-btn {
    background-color: var(--vscode-terminal-ansiGreen, #4ec9b0);
    color: #1e1e1e;
    font-weight: 600;
}

.diff-content-container {
    flex-grow: 1;
    overflow: auto;
    position: relative;
    width: 100%;
    height: 100%;
}

.binary-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 8px;
    padding: 32px;
    text-align: center;
    color: var(--vscode-descriptionForeground, #888888);
}

.binary-icon {
    font-size: 48px;
    color: var(--vscode-icon-foreground, #777777);
    margin-bottom: 8px;
}

.binary-card h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--vscode-foreground, #ffffff);
}

.binary-filename {
    margin: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
}

.binary-description {
    margin: 0;
    font-size: 12px;
}
</style>
