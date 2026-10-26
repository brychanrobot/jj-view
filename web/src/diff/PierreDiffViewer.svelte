<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { type DiffLineAnnotation, FileDiff, type FileDiffOptions, parseDiffFromFile } from '@pierre/diffs';
import { Editor } from '@pierre/diffs/edit';
import { onDestroy, onMount, untrack } from 'svelte';
import type { Uri } from '../../../src/core/uri-utils';
import type { CommentThreadHandle } from '../comments/comments-store.svelte';
import { ThreadAnnotationMounts } from '../comments/thread-annotation-mounts';
import { isBinaryFile, isImageByExtension, isSvgByExtension } from './binary-detection';
import { type EditorChatContextSelection, resolveDiffOrFileSelection } from './chat-context-selection';
import { handleEditorKeyDown } from './editor-shortcuts';
import { ensureHighlighterRegistered, getOrCreateDiffWorkerPool, isLightTheme } from './highlighter-setup';
import ImageDiffViewer from './ImageDiffViewer.svelte';
import { startRenderTrace } from './render-perf';

interface Props {
    filename: string;
    resourceUri?: Uri;
    originalContent?: string;
    modifiedContent?: string;
    fileStatus?: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
    isWorkingCopy?: boolean;
    isConflict?: boolean;
    parentMutable?: boolean;
    theme?: string;
    initialDirty?: boolean;
    /** Review threads anchored to this file; rendered inline under their line. */
    commentThreads?: readonly CommentThreadHandle[];
    onReplyToThread?: (handle: CommentThreadHandle, text: string, resolve: boolean) => Promise<void>;
    onSetThreadResolved?: (handle: CommentThreadHandle, resolved: boolean) => Promise<void>;
    onSave?: (newContent: string) => Promise<void> | void;
    onDiscard?: () => Promise<void> | void;
    onResolveConflict?: () => Promise<void> | void;
    onOpenMergeEditor?: () => Promise<void> | void;
    onDirtyChange?: (isDirty: boolean) => void;
    onContentChange?: (newContent: string) => void;
    onSelectionChange?: (ranges: { startLine: number; endLine: number }[] | undefined) => void;
    onSquashSelection?: (ranges: { startLine: number; endLine: number }[]) => Promise<void> | void;
    onAddSelectionToChat?: () => Promise<void> | void;
}

let {
    filename,
    resourceUri,
    originalContent = '',
    modifiedContent = '',
    fileStatus,
    isWorkingCopy = false,
    isConflict = false,
    parentMutable = false,
    theme: themeProp = '',
    initialDirty = false,
    commentThreads = [],
    onReplyToThread,
    onSetThreadResolved,
    onSave,
    onDiscard,
    onResolveConflict,
    onOpenMergeEditor,
    onDirtyChange,
    onContentChange,
    onSelectionChange,
    onSquashSelection,
    onAddSelectionToChat,
}: Props = $props();

let containerEl: HTMLDivElement | null = $state(null);
let diffStyle: 'split' | 'unified' = $state('split');
// svelte-ignore state_referenced_locally
let isDirty = $state(initialDirty);
let isSaving = $state(false);
let saveMessage = $state<string | null>(null);
let canUndo = $state(false);
let canRedo = $state(false);
let currentContent = $state('');
let selectedRanges = $state<{ startLine: number; endLine: number }[] | undefined>(undefined);
let selectedLineSide = $state<'deletions' | 'additions' | undefined>(undefined);

let fileDiffInstance: FileDiff<CommentThreadHandle> | null = null;
let editorInstance: Editor<'file-diff', CommentThreadHandle> | null = null;
let detachEditor: (() => void) | null = null;
// Incremented on every render/cleanup so a pending async editor attach can
// detect it has been superseded and bail out instead of attaching to a stale
// FileDiff instance.
let renderGeneration = 0;
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let saveMessageTimer: ReturnType<typeof setTimeout> | null = null;
// Svelte components mounted into Pierre's annotation slots, by thread id.
const threadMounts = new ThreadAnnotationMounts({
    onReply: (handle, text, resolve) => onReplyToThread?.(handle, text, resolve) ?? Promise.resolve(),
    onSetResolved: (handle, resolved) => onSetThreadResolved?.(handle, resolved) ?? Promise.resolve(),
});

const isRasterImage = $derived(isImageByExtension(filename));
const isSvg = $derived(isSvgByExtension(filename));
let svgPreviewMode = $state(false);
const showImageDiff = $derived(isRasterImage || (isSvg && svgPreviewMode));
const isBinary = $derived(
    !isRasterImage && (isBinaryFile(filename, modifiedContent) || isBinaryFile(filename, originalContent)),
);

/**
 * Threads become Pierre line annotations on the new-file side (the side the
 * forge's line numbers refer to). `lineNumber: 0` is Pierre's file-level slot,
 * which is where file-level review comments belong.
 */
function buildLineAnnotations(
    handles: readonly CommentThreadHandle[],
    isDeleted: boolean,
): DiffLineAnnotation<CommentThreadHandle>[] {
    return handles.map((handle) => ({
        side: isDeleted ? 'deletions' : 'additions',
        lineNumber: Math.max(0, handle.thread.line ?? 0),
        metadata: handle,
    }));
}

/**
 * Pierre's `setOptions` replaces the whole options object, so every options
 * object (construction and diff-style toggles) is built here to keep
 * `renderAnnotation` attached.
 */
function buildFileDiffOptions(
    effectiveTheme: string,
    themeType: 'light' | 'dark',
): FileDiffOptions<CommentThreadHandle, undefined> {
    return {
        diffStyle: untrack(() => diffStyle),
        expandUnchanged: untrack(() => isConflict),
        disableFileHeader: true,
        theme: effectiveTheme,
        themeType,
        enableLineSelection: true,
        onLineSelected: handleLineSelection,
        onLineSelectionChange: handleLineSelection,
        onLineSelectionEnd: handleLineSelection,
        renderAnnotation: (annotation) => threadMounts.render(annotation.metadata),
    };
}

$effect(() => {
    const handles = commentThreads;
    const instance = fileDiffInstance;
    if (!instance) {
        return;
    }
    const isDeleted = fileStatus === 'deleted' || (Boolean(originalContent) && !untrack(() => currentContent));
    instance.setLineAnnotations(buildLineAnnotations(handles, isDeleted));
    threadMounts.retainOnly(new Set(handles.map((h) => h.id)));
});

function cleanupInstances(): void {
    renderGeneration++;
    selectedRanges = undefined;
    selectedLineSide = undefined;
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
    threadMounts.unmountAll();
    if (fileDiffInstance) {
        fileDiffInstance.cleanUp();
        fileDiffInstance = null;
    }
}

function handleLineSelection(
    range: { start?: number; end?: number; side?: 'deletions' | 'additions' } | null | undefined,
): void {
    if (!range || typeof range.start !== 'number' || typeof range.end !== 'number') {
        selectedRanges = undefined;
        selectedLineSide = undefined;
        onSelectionChange?.(undefined);
        return;
    }
    const startLine = Math.max(0, Math.min(range.start, range.end) - 1);
    const endLine = Math.max(startLine, Math.max(range.start, range.end) - 1);
    selectedRanges = [{ startLine, endLine }];
    selectedLineSide = range.side;
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
            lastLoadedModified = currentContent;
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
    currentContent = originalContent;
    lastLoadedModified = originalContent;
    onContentChange?.(originalContent);
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
    if (!containerEl || isBinary || showImageDiff || typeof window === 'undefined') {
        return;
    }

    const cleanName = filename.replace(/\s*\([^)]*\)$/, '').trim();
    const trace = startRenderTrace(cleanName);

    cleanupInstances();
    containerEl.innerHTML = '';

    ensureHighlighterRegistered();

    const effectiveTheme =
        themeProp ||
        (typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null) ||
        'pierre-dark-soft';
    const isLight = isLightTheme(effectiveTheme);
    const themeType = isLight ? 'light' : 'dark';
    const workerManager = getOrCreateDiffWorkerPool(effectiveTheme);

    fileDiffInstance = new FileDiff<CommentThreadHandle>(
        buildFileDiffOptions(effectiveTheme, themeType),
        workerManager,
    );

    const contentToRender = untrack(() => currentContent);

    const isAdded = fileStatus === 'added' || (!originalContent && Boolean(contentToRender));
    const isDeleted = fileStatus === 'deleted' || (Boolean(originalContent) && !contentToRender);
    const oldFile = isAdded
        ? null
        : {
              name: cleanName,
              contents: originalContent,
              cacheKey: `${cleanName}:orig:${originalContent.length}`,
          };
    const newFile = isDeleted
        ? null
        : {
              name: cleanName,
              contents: contentToRender,
              cacheKey: `${cleanName}:mod:${contentToRender.length}`,
          };
    // Parse once so we hold the exact diff object the worker pool caches under;
    // that lets us await its highlight before attaching the editor (see below).
    const fileDiff = parseDiffFromFile(oldFile, newFile);
    // Later thread changes are applied by the commentThreads effect, not by re-rendering.
    const lineAnnotations = untrack(() => buildLineAnnotations(commentThreads, isDeleted));
    trace.phase('setup');

    const renderStart = performance.now();
    fileDiffInstance.render({
        containerWrapper: containerEl,
        fileDiff,
        lineAnnotations,
    });
    const renderDuration = performance.now() - renderStart;
    trace.phase('render');
    const oldLines = oldFile?.contents ? oldFile.contents.split('\n').length : 0;
    const newLines = newFile?.contents ? newFile.contents.split('\n').length : 0;
    if (typeof console !== 'undefined' && console.log) {
        console.log(
            `[Perf:Pierre] renderDiff(${cleanName}) rendered in ${renderDuration.toFixed(1)}ms [oldLines: ${oldLines}, newLines: ${newLines}, theme: ${effectiveTheme}, style: ${diffStyle}]`,
        );
    }

    if (!isWorkingCopy) {
        trace.finish(`[lines: ${oldLines}+${newLines}, style: ${diffStyle}, editor: false]`);
        return;
    }

    trace.finish(`[lines: ${oldLines}+${newLines}, style: ${diffStyle}, editor: deferred]`);
    void attachEditorWhenHighlighted(fileDiffInstance, fileDiff, workerManager, cleanName);
}

/**
 * Attaches the editor only after the worker pool has delivered the highlighted
 * render for `fileDiff`. `Editor.edit()` can reuse that result as-is; attaching
 * before it lands forces a synchronous main-thread re-highlight of the whole
 * file (~1s for a 2.4k-line diff), which was the dominant cost of opening a
 * working-copy diff.
 */
async function attachEditorWhenHighlighted(
    instance: FileDiff<CommentThreadHandle>,
    fileDiff: ReturnType<typeof parseDiffFromFile>,
    workerManager: ReturnType<typeof getOrCreateDiffWorkerPool>,
    label: string,
): Promise<void> {
    const generation = ++renderGeneration;
    const waitStart = performance.now();
    let waitedFor = 'none';
    if (workerManager && fileDiff.cacheKey != null) {
        try {
            await workerManager.primeDiffHighlightCache(fileDiff);
            waitedFor = 'worker-highlight';
        } catch {
            waitedFor = 'worker-unavailable';
        }
    }
    const waited = performance.now() - waitStart;

    // The user may have navigated away while the highlight was in flight.
    if (generation !== renderGeneration || fileDiffInstance !== instance) {
        return;
    }

    const attachStart = performance.now();
    try {
        editorInstance = new Editor<'file-diff', CommentThreadHandle>('file-diff', {
            onChange: () => {
                if (editorInstance) {
                    const text = editorInstance.getText();
                    currentContent = text;
                    lastLoadedModified = text;
                    isDirty = true;
                    canUndo = editorInstance.canUndo;
                    canRedo = editorInstance.canRedo;
                    onDirtyChange?.(true);
                    onContentChange?.(text);
                    scheduleAutoSave();
                }
            },
        });
        detachEditor = editorInstance.edit(instance);
    } catch {
        // Fallback gracefully in testing or headless environments
    }
    if (typeof console !== 'undefined' && console.log) {
        console.log(
            `[Perf:Pierre] editorAttach(${label}) waited=${waited.toFixed(1)}ms (${waitedFor}) attach=${(performance.now() - attachStart).toFixed(1)}ms`,
        );
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
        fileDiffInstance.setOptions(buildFileDiffOptions(effectiveTheme, themeType));
        const contentToRender = untrack(() => currentContent);
        const cleanName = filename.replace(/\s*\([^)]*\)$/, '').trim();
        const isAdded = fileStatus === 'added' || (!originalContent && Boolean(contentToRender));
        const isDeleted = fileStatus === 'deleted' || (Boolean(originalContent) && !contentToRender);
        const oldFile = isAdded
            ? null
            : {
                  name: cleanName,
                  contents: originalContent,
                  cacheKey: `${cleanName}:orig:${originalContent.length}`,
              };
        const newFile = isDeleted
            ? null
            : {
                  name: cleanName,
                  contents: contentToRender,
                  cacheKey: `${cleanName}:mod:${contentToRender.length}`,
              };
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

export function getChatContextSelection(): EditorChatContextSelection | null {
    return (
        resolveDiffOrFileSelection({
            filename,
            resourceUri,
            isWorkingCopy,
            containerEl,
            modifiedContent: currentContent || modifiedContent,
            originalContent,
            editorInstance,
            selectedRanges,
            selectedLineSide,
        }) ?? null
    );
}

function handleKeyDown(e: KeyboardEvent): void {
    handleEditorKeyDown(e, {
        isWorkingCopy,
        canUndo,
        canRedo,
        onSave: handleSave,
        onUndo: handleUndo,
        onRedo: handleRedo,
        onAddSelectionToChat,
        onEscape: () => {
            if (selectedRanges) {
                selectedRanges = undefined;
                selectedLineSide = undefined;
                onSelectionChange?.(undefined);
            }
        },
    });
}

let lastRenderedFilename = '';
// svelte-ignore state_referenced_locally
let lastLoadedModified = modifiedContent;
// svelte-ignore state_referenced_locally
let lastLoadedOriginal = originalContent;
// svelte-ignore state_referenced_locally
let lastRenderedWorkingCopy = isWorkingCopy;

// Synchronize and re-render when filename, content, or mode change
$effect(() => {
    const fn = filename;
    const orig = originalContent;
    const mod = modifiedContent;
    const status = fileStatus;
    const wc = isWorkingCopy;

    if (fn !== lastRenderedFilename) {
        if (!orig && !mod && status !== 'added' && status !== 'deleted') {
            lastRenderedFilename = fn;
            return;
        }
        if (typeof console !== 'undefined' && console.log) {
            console.log(
                `[Perf:Pierre] $effect filename changed to "${fn}" (modLen: ${mod.length}, origLen: ${orig.length})`,
            );
        }
        lastRenderedFilename = fn;
        lastLoadedModified = mod;
        lastLoadedOriginal = orig;
        lastRenderedWorkingCopy = wc;
        currentContent = mod;
        isDirty = initialDirty;
        canUndo = false;
        canRedo = false;
        onDirtyChange?.(initialDirty);
        renderDiff();
    } else if (
        !isDirty &&
        (mod !== lastLoadedModified || orig !== lastLoadedOriginal || wc !== lastRenderedWorkingCopy)
    ) {
        if (typeof console !== 'undefined' && console.log) {
            console.log(
                `[Perf:Pierre] $effect content updated for "${fn}" (modLen: ${mod.length}, origLen: ${orig.length})`,
            );
        }
        lastLoadedModified = mod;
        lastLoadedOriginal = orig;
        lastRenderedWorkingCopy = wc;
        currentContent = mod;
        renderDiff();
    } else {
        void status;
    }
});

let wasNarrow = false;
$effect(() => {
    if (!containerEl) {
        return;
    }
    const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
            const isNarrow = entry.contentRect.width > 0 && entry.contentRect.width < 600;
            if (isNarrow && !wasNarrow) {
                if (untrack(() => diffStyle) === 'split') {
                    setDiffStyle('unified');
                }
            }
            wasNarrow = isNarrow;
        }
    });
    observer.observe(containerEl);
    return () => {
        observer.disconnect();
    };
});
onMount(() => {
    if (typeof window !== 'undefined') {
        window.addEventListener('keydown', handleKeyDown, true);
    }
});

onDestroy(() => {
    if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', handleKeyDown, true);
    }
    cleanupInstances();
});
</script>

<div class="pierre-diff-viewer" data-testid="pierre-diff-viewer">
    {#if !showImageDiff && !isBinary}
        <div class="diff-style-toggle-floating" role="group" aria-label="Diff style">
            <button
                type="button"
                class="toggle-btn"
                class:active={diffStyle === 'split'}
                onclick={() => setDiffStyle('split')}
                title="Side-by-side split diff"
                data-testid="toggle-split-diff"
                data-style="split"
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
                data-style="unified"
            >
                Unified
            </button>
            {#if isSvg}
                <button
                    type="button"
                    class="toggle-btn"
                    onclick={() => {
                        cleanupInstances();
                        svgPreviewMode = true;
                    }}
                    title="Preview rendered SVG diff"
                    data-testid="toggle-svg-preview"
                >
                    Preview
                </button>
            {/if}
        </div>
    {/if}

    {#if isConflict && (onResolveConflict || onOpenMergeEditor)}
        <div class="diff-conflict-floating">
            {#if onOpenMergeEditor}
                <button
                    type="button"
                    class="resolve-btn"
                    onclick={() => onOpenMergeEditor?.()}
                    title="Open in 3-Way Merge Editor"
                    data-testid="diff-open-merge-editor-btn"
                >
                    <span>Open Merge Editor</span>
                </button>
            {/if}
            {#if onResolveConflict}
                <button
                    type="button"
                    class="resolve-btn"
                    onclick={handleResolveConflict}
                    title="Mark conflict as resolved"
                    data-testid="diff-resolve-conflict-btn"
                >
                    <i class="codicon codicon-check" aria-hidden="true"></i>
                    <span>Mark Resolved</span>
                </button>
            {/if}
        </div>
    {/if}

    {#if showImageDiff}
        <ImageDiffViewer
            {filename}
            {originalContent}
            modifiedContent={currentContent || modifiedContent}
            {fileStatus}
            onSwitchToCode={isSvg
                ? () => {
                      svgPreviewMode = false;
                      queueMicrotask(() => renderDiff());
                  }
                : undefined}
        />
    {:else if isBinary}
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
            data-vscode-context={JSON.stringify({
                menuId: 'editor/context',
                isInDiffEditor: true,
                'jj.parentMutable': parentMutable,
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
}

.pierre-diff-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background-color: var(--vscode-editor-background, #171717);
    color: var(--vscode-editor-foreground, #d4d4d4);
    overflow: hidden;
    position: relative;
    --diffs-font-family: var(--vscode-editor-font-family, monospace);
    --diffs-font-size: var(--vscode-editor-font-size, 12px);
    --diffs-line-height: var(--vscode-editor-line-height, 19px);
}

.diff-style-toggle-floating {
    position: absolute;
    top: 8px;
    right: 16px;
    z-index: 10;
    display: inline-flex;
    align-items: stretch;
    height: 24px;
    border: 1px solid var(--vscode-input-border, #2c2c2c);
    border-radius: 6px;
    background: var(--vscode-input-background, #262626);
    overflow: hidden;
    box-sizing: border-box;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
}

.diff-conflict-floating {
    position: absolute;
    top: 8px;
    right: 136px;
    z-index: 10;
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.resolve-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 10px;
    border-radius: 4px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
    font-family: inherit;
    transition: background 0.15s ease;
}

.resolve-btn:hover {
    background: var(--vscode-button-hoverBackground);
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
