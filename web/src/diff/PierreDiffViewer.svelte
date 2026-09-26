<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { FileDiff } from '@pierre/diffs';
import { Editor } from '@pierre/diffs/edit';
import { onDestroy, onMount, untrack } from 'svelte';
import { isBinaryFile } from './binary-detection';
import { ensureHighlighterRegistered, isLightTheme } from './highlighter-setup';

interface Props {
    filename: string;
    originalContent?: string;
    modifiedContent?: string;
    fileStatus?: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
    isWorkingCopy?: boolean;
    isConflict?: boolean;
    theme?: string;
    onSave?: (newContent: string) => Promise<void> | void;
    onDiscard?: () => Promise<void> | void;
    onResolveConflict?: () => Promise<void> | void;
}

let {
    filename,
    originalContent = '',
    modifiedContent = '',
    fileStatus,
    isWorkingCopy = false,
    isConflict = false,
    theme: themeProp = '',
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
    editorInstance = null;
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

    ensureHighlighterRegistered();

    const effectiveTheme =
        themeProp ||
        (typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null) ||
        'pierre-dark-soft';
    const isLight = isLightTheme(effectiveTheme);
    const themeType = isLight ? 'light' : 'dark';

    fileDiffInstance = new FileDiff({
        diffStyle,
        expandUnchanged: false,
        disableFileHeader: true,
        theme: effectiveTheme,
        themeType,
    });

    const contentToRender = untrack(() => currentContent);

    const cleanName = filename.replace(/\s*\([^)]*\)$/, '').trim();

    const isAdded = fileStatus === 'added' || (!originalContent && Boolean(contentToRender));
    const isDeleted = fileStatus === 'deleted' || (Boolean(originalContent) && !contentToRender);
    const oldFile = isAdded ? null : { name: cleanName, contents: originalContent };
    const newFile = isDeleted ? null : { name: cleanName, contents: contentToRender };

    fileDiffInstance.render({
        containerWrapper: containerEl,
        oldFile,
        newFile,
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

function setDiffStyle(style: 'split' | 'unified'): void {
    if (diffStyle === style) {
        return;
    }
    diffStyle = style;
    const isLight =
        typeof document !== 'undefined' &&
        (document.body.classList.contains('vscode-light') || themeProp.includes('light'));
    const effectiveTheme =
        themeProp ||
        (typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null) ||
        (isLight ? 'pierre-light-soft' : 'pierre-dark-soft');
    const themeType = effectiveTheme.includes('light') ? 'light' : 'dark';

    if (fileDiffInstance) {
        fileDiffInstance.setOptions({
            diffStyle,
            expandUnchanged: false,
            disableFileHeader: true,
            theme: effectiveTheme,
            themeType,
        });
        const contentToRender = untrack(() => currentContent);
        const cleanName = filename.replace(/\s*\([^)]*\)$/, '').trim();
        const isAdded = fileStatus === 'added' || (!originalContent && Boolean(contentToRender));
        const isDeleted = fileStatus === 'deleted' || (Boolean(originalContent) && !contentToRender);
        const oldFile = isAdded ? null : { name: cleanName, contents: originalContent };
        const newFile = isDeleted ? null : { name: cleanName, contents: contentToRender };
        fileDiffInstance.render({
            containerWrapper: containerEl,
            forceRender: true,
            oldFile,
            newFile,
        });
        return;
    }
    renderDiff();
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

// Re-render when filename, content, or mode change
$effect(() => {
    // Explicitly track these props
    void filename;
    void originalContent;
    void modifiedContent;
    void fileStatus;
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
                    onclick={() => setDiffStyle('split')}
                    title="Side-by-side split diff"
                    data-testid="toggle-split-diff"
                >
                    Split
                </button>
                <button
                    type="button"
                    class="toggle-btn"
                    class:active={diffStyle === 'unified'}
                    onclick={() => setDiffStyle('unified')}
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
:global(diffs-container) {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
}

.pierre-diff-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background-color: var(--vscode-editor-background, #171717);
    color: var(--vscode-editor-foreground, #d4d4d4);
    overflow: hidden;
    --diffs-font-family: var(--vscode-editor-font-family, monospace);
    --diffs-font-size: var(--vscode-editor-font-size, 12px);
    --diffs-line-height: var(--vscode-editor-line-height, 19px);
}

.diff-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 35px;
    padding: 0 16px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground, #171717);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #1d1d1d);
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
    color: var(--vscode-editorOverviewRuler-modifiedForeground, #69b1ff);
    font-size: 14px;
}

.save-status {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
}

.toolbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
}

.diff-style-toggle {
    display: inline-flex;
    align-items: stretch;
    height: 24px;
    border: 1px solid var(--vscode-input-border, #2c2c2c);
    border-radius: 6px;
    background: var(--vscode-input-background, #262626);
    overflow: hidden;
    box-sizing: border-box;
}

.toggle-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 10px;
    border: none;
    border-right: 1px solid var(--vscode-input-border, #2c2c2c);
    background: transparent;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s ease, color 0.15s ease;
    white-space: nowrap;
    outline: none;
    user-select: none;
}

.toggle-btn:last-child {
    border-right: none;
}

.toggle-btn:hover:not(.active) {
    background: var(--vscode-toolbar-hoverBackground, rgba(31, 62, 94, 0.45));
    color: var(--vscode-foreground, #d4d4d4);
}

.toggle-btn.active {
    background: var(--vscode-button-background, #69b1ff);
    color: var(--vscode-button-foreground, #171717);
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
    gap: 6px;
    background-color: var(--vscode-button-secondaryBackground, #262626);
    color: var(--vscode-button-secondaryForeground, #d4d4d4);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    line-height: normal;
    transition: background-color 0.15s;
}

.toolbar-btn:hover:not(:disabled) {
    background-color: var(--vscode-button-secondaryHoverBackground, #2c2c2c);
}

.toolbar-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.toolbar-btn.primary {
    background-color: var(--vscode-button-background, #69b1ff);
    color: var(--vscode-button-foreground, #171717);
}

.toolbar-btn.primary:hover:not(:disabled) {
    background-color: var(--vscode-button-hoverBackground, #61a2e8);
}

.toolbar-btn.danger {
    background-color: var(--vscode-inputValidation-errorBackground, #ff6762);
    color: #171717;
}

.toolbar-btn.danger:hover:not(:disabled) {
    background-color: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, #ff6762) 85%, black);
}

.toolbar-btn.resolve-btn {
    background-color: var(--vscode-terminal-ansiGreen, #60d199);
    color: #171717;
    font-weight: 600;
}

.toolbar-btn.resolve-btn:hover:not(:disabled) {
    background-color: color-mix(in srgb, var(--vscode-terminal-ansiGreen, #60d199) 85%, black);
}

.diff-content-container {
    flex: 1 1 0;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    position: relative;
    width: 100%;
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
    color: var(--vscode-descriptionForeground, #8a8a8a);
}

.binary-icon {
    font-size: 48px;
    color: var(--vscode-icon-foreground, #8a8a8a);
    margin-bottom: 8px;
}

.binary-card h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--vscode-foreground, #d4d4d4);
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
