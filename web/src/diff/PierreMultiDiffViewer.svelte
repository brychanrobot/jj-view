<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import {
    CodeView,
    type CodeViewDiffItem,
    type CodeViewFileItem,
    type CodeViewOptions,
    type DiffLineAnnotation,
    type LineAnnotation,
    parseDiffFromFile,
} from '@pierre/diffs';
import { onDestroy, onMount, untrack } from 'svelte';
import type { CommentThreadHandle } from '../comments/comments-store.svelte';
import { ThreadAnnotationMounts } from '../comments/thread-annotation-mounts';
import type { MultiDiffFileEntry } from '../tabs/tab-types';
import { isBinaryFile } from './binary-detection';
import { ensureHighlighterRegistered, isLightTheme } from './highlighter-setup';

interface Props {
    title: string;
    files: MultiDiffFileEntry[];
    theme?: string;
    onSave?: (filename: string, newContent: string) => Promise<void> | void;
    onDiscard?: (filename: string) => Promise<void> | void;
    /** Review threads per entry, keyed by {@link MultiDiffFileEntry.filename}. */
    commentThreads?: ReadonlyMap<string, readonly CommentThreadHandle[]>;
    onReplyToThread?: (handle: CommentThreadHandle, text: string, resolve: boolean) => Promise<void>;
    onSetThreadResolved?: (handle: CommentThreadHandle, resolved: boolean) => Promise<void>;
}

let {
    title,
    files,
    theme: themeProp = '',
    onSave: _onSave,
    onDiscard: _onDiscard,
    commentThreads,
    onReplyToThread,
    onSetThreadResolved,
}: Props = $props();

let containerEl: HTMLDivElement | null = $state(null);
let diffStyle: 'split' | 'unified' = $state('split');
let codeView: CodeView<CommentThreadHandle> | null = null;
const threadMounts = new ThreadAnnotationMounts({
    onReply: (handle, text, resolve) => onReplyToThread?.(handle, text, resolve) ?? Promise.resolve(),
    onSetResolved: (handle, resolved) => onSetThreadResolved?.(handle, resolved) ?? Promise.resolve(),
});

/**
 * Which threads are anchored where. Mounted thread views track edits to a
 * thread on their own (the handle is reactive), so the view only needs to be
 * rebuilt when threads appear or disappear, not on every comments poll.
 */
const threadLayoutKey = $derived(
    files
        .map((file) =>
            (commentThreads?.get(file.filename) ?? [])
                .map((handle) => `${handle.id}@${handle.thread.line ?? 0}`)
                .join(','),
        )
        .join('|'),
);

function threadsFor(file: MultiDiffFileEntry): readonly CommentThreadHandle[] {
    return commentThreads?.get(file.filename) ?? [];
}

function fileAnnotations(file: MultiDiffFileEntry): LineAnnotation<CommentThreadHandle>[] {
    return threadsFor(file).map((handle) => ({ lineNumber: Math.max(0, handle.thread.line ?? 0), metadata: handle }));
}

function diffAnnotations(file: MultiDiffFileEntry, isDeleted: boolean): DiffLineAnnotation<CommentThreadHandle>[] {
    return threadsFor(file).map((handle) => ({
        side: isDeleted ? 'deletions' : 'additions',
        lineNumber: Math.max(0, handle.thread.line ?? 0),
        metadata: handle,
    }));
}

function cleanup(): void {
    threadMounts.unmountAll();
    if (codeView) {
        codeView.cleanUp();
        codeView = null;
    }
}

function buildCodeViewOptions(
    effectiveTheme: string,
    themeType: 'light' | 'dark',
): CodeViewOptions<CommentThreadHandle, undefined> {
    return {
        diffStyle,
        expandUnchanged: false,
        disableFileHeader: false,
        theme: effectiveTheme,
        themeType,
        renderAnnotation: (annotation: LineAnnotation<CommentThreadHandle> | DiffLineAnnotation<CommentThreadHandle>) =>
            threadMounts.render(annotation.metadata),
    };
}

function renderMultiDiff(): void {
    if (!containerEl || typeof window === 'undefined') {
        return;
    }

    cleanup();
    containerEl.innerHTML = '';

    ensureHighlighterRegistered();

    const effectiveTheme =
        themeProp ||
        (typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null) ||
        'pierre-dark-soft';
    const isLight = isLightTheme(effectiveTheme);
    const themeType = isLight ? 'light' : 'dark';

    codeView = new CodeView<CommentThreadHandle>(buildCodeViewOptions(effectiveTheme, themeType));

    codeView.setup(containerEl);

    const items: (CodeViewDiffItem<CommentThreadHandle> | CodeViewFileItem<CommentThreadHandle>)[] = [];
    const currentFiles = untrack(() => files);

    for (const file of currentFiles) {
        const cleanName = file.filename
            .replace(/\s*\([^)]*\)$/, '')
            .replace(/^[/\\]+/, '')
            .trim();
        const orig = file.originalContent ?? '';
        const mod = file.modifiedContent ?? '';

        if (isBinaryFile(cleanName, mod) || isBinaryFile(cleanName, orig)) {
            continue;
        }

        const isAdded = file.fileStatus === 'added' || (!orig && Boolean(mod));
        const isDeleted = file.fileStatus === 'deleted' || (Boolean(orig) && !mod);
        const oldFile = isAdded ? null : { name: cleanName, contents: orig };
        const newFile = isDeleted ? null : { name: cleanName, contents: mod };

        if (orig === mod && !isAdded && !isDeleted) {
            items.push({
                id: cleanName,
                type: 'file',
                file: { name: cleanName, contents: mod },
                annotations: fileAnnotations(file),
            });
            continue;
        }

        try {
            const fileDiff = parseDiffFromFile(oldFile, newFile);
            items.push({
                id: cleanName,
                type: 'diff',
                fileDiff,
                annotations: diffAnnotations(file, isDeleted),
            });
        } catch {
            items.push({
                id: cleanName,
                type: 'file',
                file: { name: cleanName, contents: mod || orig },
                annotations: fileAnnotations(file),
            });
        }
    }

    codeView.setItems(items);
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

    if (codeView) {
        codeView.setOptions(buildCodeViewOptions(effectiveTheme, themeType));
        codeView.render(true);
        return;
    }
    renderMultiDiff();
}

onMount(() => {
    renderMultiDiff();
    return () => {
        cleanup();
    };
});

onDestroy(() => {
    cleanup();
});

$effect(() => {
    // Re-render if the files list, theme, or the set of anchored threads changes.
    const _f = files;
    const _t = themeProp;
    const _k = threadLayoutKey;
    untrack(() => {
        if (containerEl) {
            renderMultiDiff();
        }
    });
});
</script>

<div class="pierre-multi-diff-viewer" data-testid="pierre-multi-diff-viewer">
    <div class="diff-style-toggle-floating" role="group" aria-label="Diff style">
        <button
            type="button"
            class="toggle-btn"
            class:active={diffStyle === 'split'}
            onclick={() => setDiffStyle('split')}
            title="Side-by-side Diff"
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
            title="Inline / Unified Diff"
            data-testid="toggle-unified-diff"
            data-style="unified"
        >
            Unified
        </button>
    </div>

    <div
        class="diff-content-container"
        data-testid="multi-diff-content-container"
        bind:this={containerEl}
    ></div>
</div>

<style>
.pierre-multi-diff-viewer {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
}

.diff-style-toggle-floating {
    position: absolute;
    top: 8px;
    right: 16px;
    z-index: 10;
    display: inline-flex;
    align-items: center;
    border-radius: 4px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #454545));
    background: var(--vscode-editor-background);
    padding: 2px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.toggle-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    height: 22px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s ease, color 0.15s ease;
    white-space: nowrap;
    outline: none;
    user-select: none;
}

.toggle-btn:hover:not(.active) {
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.06));
    color: var(--vscode-foreground);
}

.toggle-btn.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-weight: 600;
}

.diff-content-container {
    flex: 1 1 0;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    position: relative;
    width: 100%;
    height: 100%;
}
</style>
