<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { File } from '@pierre/diffs';
import { Editor } from '@pierre/diffs/edit';
import { onDestroy, onMount, untrack } from 'svelte';
import type { Uri } from '../../../src/core/uri-utils';
import { isBinaryFile } from './binary-detection';
import { handleEditorKeyDown } from './editor-shortcuts';
import { ensureHighlighterRegistered, isLightTheme } from './highlighter-setup';

interface Props {
    filename: string;
    resourceUri?: Uri;
    content?: string;
    isWorkingCopy?: boolean;
    theme?: string;
    initialDirty?: boolean;
    onSave?: (newContent: string) => Promise<void> | void;
    onDiscard?: () => Promise<void> | void;
    onDirtyChange?: (isDirty: boolean) => void;
    onContentChange?: (newContent: string) => void;
    onSelectionChange?: (ranges: { startLine: number; endLine: number }[] | undefined) => void;
}

let {
    filename,
    resourceUri,
    content = '',
    isWorkingCopy = false,
    theme: themeProp = '',
    initialDirty = false,
    onSave,
    onDiscard,
    onDirtyChange,
    onContentChange,
    onSelectionChange,
}: Props = $props();

let containerEl: HTMLDivElement | null = $state(null);
// svelte-ignore state_referenced_locally
let isDirty = $state(initialDirty);
let isSaving = $state(false);
let saveMessage = $state<string | null>(null);
let canUndo = $state(false);
let canRedo = $state(false);
let currentContent = $state('');
let selectedRanges = $state<{ startLine: number; endLine: number }[] | undefined>(undefined);

let fileInstance: File | null = null;
let editorInstance: Editor<'file'> | null = null;
let detachEditor: (() => void) | null = null;
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let saveMessageTimer: ReturnType<typeof setTimeout> | null = null;

const isBinary = $derived(isBinaryFile(filename, content));

function cleanupInstances(): void {
    selectedRanges = undefined;
    onSelectionChange?.(undefined);
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
    if (fileInstance) {
        fileInstance.cleanUp();
        fileInstance = null;
    }
}

function handleLineSelection(range: { start?: number; end?: number } | null | undefined): void {
    if (!range || typeof range.start !== 'number' || typeof range.end !== 'number') {
        selectedRanges = undefined;
        onSelectionChange?.(undefined);
        return;
    }
    const startLine = Math.max(0, Math.min(range.start, range.end) - 1);
    const endLine = Math.max(startLine, Math.max(range.start, range.end) - 1);
    selectedRanges = [{ startLine, endLine }];
    onSelectionChange?.(selectedRanges);
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
            lastLoadedContent = currentContent;
            onDirtyChange?.(false);
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
    onDirtyChange?.(false);
    currentContent = content;
    lastLoadedContent = content;
    onContentChange?.(content);
    if (onDiscard) {
        await onDiscard();
    }
    renderFile();
}

function scheduleAutoSave(): void {
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
    }
    saveDebounceTimer = setTimeout(() => {
        void handleSave();
    }, 750);
}

function renderFile(): void {
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

    fileInstance = new File({
        disableFileHeader: true,
        theme: effectiveTheme,
        themeType,
        enableLineSelection: true,
        onLineSelected: handleLineSelection,
        onLineSelectionChange: handleLineSelection,
        onLineSelectionEnd: handleLineSelection,
    });

    const contentToRender = untrack(() => currentContent);
    const cleanName = filename.replace(/\s*\([^)]*\)$/, '').trim();

    fileInstance.render({
        containerWrapper: containerEl,
        file: { name: cleanName, contents: contentToRender },
    });

    if (isWorkingCopy) {
        try {
            editorInstance = new Editor<'file'>('file', {
                onChange: () => {
                    if (editorInstance) {
                        const text = editorInstance.getText();
                        currentContent = text;
                        lastLoadedContent = text;
                        isDirty = true;
                        canUndo = editorInstance.canUndo;
                        canRedo = editorInstance.canRedo;
                        onDirtyChange?.(true);
                        onContentChange?.(text);
                        scheduleAutoSave();
                    }
                },
            });
            detachEditor = editorInstance.edit(fileInstance);
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
    handleEditorKeyDown(e, {
        isWorkingCopy,
        canUndo,
        canRedo,
        onSave: handleSave,
        onUndo: handleUndo,
        onRedo: handleRedo,
        onEscape: () => {
            if (selectedRanges) {
                selectedRanges = undefined;
                onSelectionChange?.(undefined);
            }
        },
    });
}

let lastRenderedFilename = '';
// svelte-ignore state_referenced_locally
let lastLoadedContent = content;

// Synchronize and re-render when filename or content changes
$effect(() => {
    const fn = filename;
    const c = content;
    const wc = isWorkingCopy;

    if (fn !== lastRenderedFilename) {
        lastRenderedFilename = fn;
        lastLoadedContent = c;
        currentContent = c;
        isDirty = initialDirty;
        canUndo = false;
        canRedo = false;
        onDirtyChange?.(initialDirty);
        renderFile();
    } else if (!isDirty && c !== lastLoadedContent) {
        lastLoadedContent = c;
        currentContent = c;
        renderFile();
    } else {
        void wc;
    }
});

onMount(() => {
    if (typeof window !== 'undefined') {
        window.addEventListener('keydown', handleKeyDown, true);
    }
    renderFile();
});

onDestroy(() => {
    if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', handleKeyDown, true);
    }
    cleanupInstances();
});
</script>

<div class="pierre-file-viewer" data-testid="pierre-file-viewer">
    {#if isBinary}
        <div class="binary-card" data-testid="binary-file-card">
            <i class="codicon codicon-file-binary binary-icon" aria-hidden="true"></i>
            <h3>Binary file not shown</h3>
            <p class="binary-filename">{filename}</p>
            <p class="binary-description">
                The file cannot be displayed in the text editor.
            </p>
        </div>
    {:else}
        <div
            bind:this={containerEl}
            class="file-content-container"
            data-testid="file-content-container"
            data-vscode-context={JSON.stringify({
                menuId: 'editor/context',
                isInDiffEditor: false,
                resourceScheme: resourceUri?.scheme ?? (isWorkingCopy ? 'file' : 'jj-view'),
                resourceFilename: filename.replace(/\s*\([^)]*\)$/, '').trim(),
                resourceUri: resourceUri
                    ? {
                          scheme: resourceUri.scheme,
                          path: resourceUri.path,
                          fsPath: resourceUri.fsPath,
                          authority: resourceUri.authority,
                          query: resourceUri.query,
                          fragment: resourceUri.fragment,
                      }
                    : undefined,
                preventDefaultContextMenuItems: true,
            })}
        ></div>
    {/if}
</div>

<style>
:global(diffs-container) {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: auto;
}

.pierre-file-viewer {
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

.file-content-container {
    flex: 1;
    min-height: 0;
    width: 100%;
    height: 100%;
    overflow: auto;
}

.binary-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 40px;
    text-align: center;
    color: var(--vscode-descriptionForeground, #8a8a8a);
}

.binary-icon {
    font-size: 48px;
    margin-bottom: 16px;
    color: var(--vscode-disabledForeground, #5a5a5a);
}

.binary-card h3 {
    margin: 0 0 8px 0;
    font-size: 16px;
    font-weight: 500;
    color: var(--vscode-foreground, #d4d4d4);
}

.binary-filename {
    margin: 0 0 4px 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
    color: var(--vscode-editor-foreground, #d4d4d4);
}

.binary-description {
    margin: 0;
    font-size: 12px;
}
</style>
