<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { CodeView, type CodeViewDiffItem, type CodeViewFileItem, parseDiffFromFile } from '@pierre/diffs';
import { onDestroy, onMount, untrack } from 'svelte';
import { isBinaryFile } from './binary-detection';
import { ensureHighlighterRegistered } from './highlighter-setup';

export interface MultiDiffFileEntry {
    filename: string;
    originalContent?: string;
    modifiedContent?: string;
    fileStatus?: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
    isWorkingCopy?: boolean;
    isConflict?: boolean;
}

interface Props {
    title: string;
    files: MultiDiffFileEntry[];
    theme?: string;
    onSave?: (filename: string, newContent: string) => Promise<void> | void;
    onDiscard?: (filename: string) => Promise<void> | void;
}

let { title, files, theme: themeProp = '', onSave: _onSave, onDiscard: _onDiscard }: Props = $props();

let containerEl: HTMLDivElement | null = $state(null);
let diffStyle: 'split' | 'unified' = $state('split');
let codeView: CodeView | null = null;

function cleanup(): void {
    if (codeView) {
        codeView.cleanUp();
        codeView = null;
    }
}

function renderMultiDiff(): void {
    if (!containerEl || typeof window === 'undefined') {
        return;
    }

    cleanup();
    containerEl.innerHTML = '';

    ensureHighlighterRegistered();

    const isLight =
        typeof document !== 'undefined' &&
        (document.body.classList.contains('vscode-light') || themeProp.includes('light'));
    const effectiveTheme =
        themeProp ||
        (typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null) ||
        (isLight ? 'pierre-light-soft' : 'pierre-dark-soft');
    const themeType = effectiveTheme.includes('light') ? 'light' : 'dark';

    codeView = new CodeView({
        diffStyle,
        expandUnchanged: false,
        disableFileHeader: false,
        theme: effectiveTheme,
        themeType,
    });

    codeView.setup(containerEl);

    const items: (CodeViewDiffItem | CodeViewFileItem)[] = [];
    const currentFiles = untrack(() => files);

    for (const file of currentFiles) {
        const cleanName = file.filename.replace(/\s*\([^)]*\)$/, '').trim();
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
            });
            continue;
        }

        try {
            const fileDiff = parseDiffFromFile(oldFile, newFile);
            items.push({
                id: cleanName,
                type: 'diff',
                fileDiff,
            });
        } catch {
            items.push({
                id: cleanName,
                type: 'file',
                file: { name: cleanName, contents: mod || orig },
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
        codeView.setOptions({
            diffStyle,
            expandUnchanged: false,
            disableFileHeader: false,
            theme: effectiveTheme,
            themeType,
        });
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
    // Re-render if files list or theme changes
    const _f = files;
    const _t = themeProp;
    untrack(() => {
        if (containerEl) {
            renderMultiDiff();
        }
    });
});
</script>

<div class="pierre-multi-diff-viewer" data-testid="pierre-multi-diff-viewer">
    <div class="multi-diff-toolbar" data-testid="multi-diff-toolbar">
        <div class="toolbar-title-section">
            <span class="toolbar-icon codicon codicon-diff-multiple"></span>
            <span class="toolbar-title" data-testid="multi-diff-title">{title}</span>
            <span class="file-count-badge" data-testid="multi-diff-file-count">
                {files.length} {files.length === 1 ? 'file' : 'files'}
            </span>
        </div>
        <div class="toolbar-actions">
            <div class="toggle-group" role="group" aria-label="Diff display style">
                <button
                    type="button"
                    class="toggle-btn"
                    class:active={diffStyle === 'split'}
                    onclick={() => setDiffStyle('split')}
                    title="Side-by-side Diff"
                    data-testid="toggle-split-diff"
                >
                    <span class="codicon codicon-split-horizontal"></span>
                    <span>Split</span>
                </button>
                <button
                    type="button"
                    class="toggle-btn"
                    class:active={diffStyle === 'unified'}
                    onclick={() => setDiffStyle('unified')}
                    title="Inline / Unified Diff"
                    data-testid="toggle-unified-diff"
                >
                    <span class="codicon codicon-split-vertical"></span>
                    <span>Unified</span>
                </button>
            </div>
        </div>
    </div>

    <div
        class="diff-content-container"
        data-testid="multi-diff-content-container"
        bind:this={containerEl}
    ></div>
</div>

<style>
.pierre-multi-diff-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
}

.multi-diff-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 35px;
    min-height: 35px;
    padding: 0 12px;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder);
    user-select: none;
    gap: 12px;
    box-sizing: border-box;
}

.toolbar-title-section {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
}

.toolbar-icon {
    font-size: 14px;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
}

.toolbar-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.file-count-badge {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 10px;
    background: var(--vscode-badge-background, rgba(255, 255, 255, 0.08));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
    font-weight: 500;
    flex-shrink: 0;
}

.toolbar-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}

.toggle-group {
    display: flex;
    align-items: center;
    border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.1));
    border-radius: 4px;
    overflow: hidden;
}

.toggle-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    height: 24px;
    border: none;
    border-right: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.1));
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

.toggle-btn:last-child {
    border-right: none;
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
