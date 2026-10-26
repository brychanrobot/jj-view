<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { EditorChatContextSelection } from '../diff/chat-context-selection';
import {
    type ConflictResolution,
    computeThreeWayMerge,
    ignoreConflictSide,
    inferConflictResolutionFromLines,
    type MergeCleanSegment,
    type MergeConflictHunk,
    renderMergedContent,
    resolveAllConflicts,
    resolveConflictHunk,
    syncMergeDocumentFromResultText,
    type ThreeWayMergeDocument,
    toggleAutoMergedSegment,
    toggleConflictHandled,
} from './three-way-merge';

interface Props {
    filePath: string;
    baseContent: string;
    leftContent: string;
    rightContent: string;
    leftLabel?: string;
    rightLabel?: string;
    baseLabel?: string;
    onCompleteMerge?: (resolvedContent: string) => void | Promise<void>;
    onSave?: (resolvedContent: string) => void | Promise<void>;
    onDirtyChange?: (isDirty: boolean) => void;
    onContentChange?: (resolvedContent: string) => void;
    onOpenTwoWayDiff?: () => void;
    onAddSelectionToChat?: () => void | Promise<void>;
}

let {
    filePath,
    baseContent,
    leftContent,
    rightContent,
    leftLabel = 'Current (Left / Side 1)',
    rightLabel = 'Incoming (Right / Side 2)',
    baseLabel = 'Base (Common Ancestor)',
    onCompleteMerge,
    onSave,
    onDirtyChange,
    onContentChange,
    onOpenTwoWayDiff,
    onAddSelectionToChat,
}: Props = $props();

let mergeDoc = $state<ThreeWayMergeDocument>({
    segments: [],
    eol: '\n',
    hasTrailingNewline: true,
});

let showBase = $state(false);
let showNonConflicting = $state(true);
let isRawEditMode = $state(false);
let rawTextContent = $state('');
let initialMergedBaseline = $state('');
let activeConflictIndex = $state(0);
let isCompleting = $state(false);
let expandedContextIds = $state<Record<string, boolean>>({});
let viewRootEl = $state<HTMLElement | null>(null);
let topScrollEl = $state<HTMLElement | null>(null);
let resultScrollEl = $state<HTMLElement | null>(null);
let isSyncingScroll = false;

const COLLAPSE_THRESHOLD = 8;
const CONTEXT_PADDING = 3;

const NEXT_LEFT_TOGGLE: Record<ConflictResolution, ConflictResolution> = {
    unhandled: 'left',
    base: 'left',
    custom: 'left',
    left: 'unhandled',
    right: 'both-right-first',
    'both-left-first': 'right',
    'both-right-first': 'right',
};

const NEXT_RIGHT_TOGGLE: Record<ConflictResolution, ConflictResolution> = {
    unhandled: 'right',
    base: 'right',
    custom: 'right',
    right: 'unhandled',
    left: 'both-left-first',
    'both-left-first': 'left',
    'both-right-first': 'left',
};

// Recompute 3-way merge when input contents change
$effect(() => {
    const doc = computeThreeWayMerge(baseContent, leftContent, rightContent);
    const rendered = renderMergedContent(doc);
    mergeDoc = doc;
    rawTextContent = rendered;
    initialMergedBaseline = rendered;
    activeConflictIndex = 0;
    expandedContextIds = {};
});

const conflicts = $derived(mergeDoc.segments.filter((s): s is MergeConflictHunk => s.type === 'conflict'));

const unhandledConflictCount = $derived(conflicts.filter((c) => !c.handled).length);

const autoMergedSegments = $derived(
    mergeDoc.segments.filter((s): s is MergeCleanSegment => s.type === 'clean' && s.origin !== 'unchanged'),
);

const autoMergedCount = $derived(autoMergedSegments.length);

const resultPreviewText = $derived(isRawEditMode ? rawTextContent : renderMergedContent(mergeDoc));

function notifyDocumentUpdated(nextDoc: ThreeWayMergeDocument, explicitText?: string) {
    mergeDoc = nextDoc;
    const text = explicitText ?? renderMergedContent(nextDoc);
    rawTextContent = text;
    onContentChange?.(text);
    onDirtyChange?.(text !== initialMergedBaseline);
}

function applyResolution(hunkId: string, resolution: ConflictResolution, customLines?: string[]) {
    const nextDoc = resolveConflictHunk(mergeDoc, hunkId, resolution, customLines);
    notifyDocumentUpdated(nextDoc);
}

function toggleSideResolution(hunk: MergeConflictHunk, side: 'left' | 'right') {
    const nextResolution = side === 'left' ? NEXT_LEFT_TOGGLE[hunk.resolution] : NEXT_RIGHT_TOGGLE[hunk.resolution];
    applyResolution(hunk.id, nextResolution);
}

function handleIgnoreSide(hunk: MergeConflictHunk, side: 'left' | 'right') {
    const nextDoc = ignoreConflictSide(mergeDoc, hunk.id, side);
    notifyDocumentUpdated(nextDoc);
}

function handleToggleHandled(hunk: MergeConflictHunk) {
    const nextDoc = toggleConflictHandled(mergeDoc, hunk.id);
    notifyDocumentUpdated(nextDoc);
}

function handleToggleAutoMerged(segment: MergeCleanSegment) {
    const nextDoc = toggleAutoMergedSegment(mergeDoc, segment.id);
    notifyDocumentUpdated(nextDoc);
}

function handleAcceptAll(side: 'left' | 'right') {
    const nextDoc = resolveAllConflicts(mergeDoc, side, false);
    notifyDocumentUpdated(nextDoc);
}

function handleCustomHunkInput(hunk: MergeConflictHunk, value: string) {
    const lines = value === '' ? [] : value.split('\n');
    const inferred = inferConflictResolutionFromLines(hunk, lines);
    applyResolution(hunk.id, inferred, lines);
}

function handleRawEditorInput(value: string) {
    const syncedDoc = syncMergeDocumentFromResultText(mergeDoc, value);
    notifyDocumentUpdated(syncedDoc, value);
}

function navigateConflict(delta: number) {
    if (conflicts.length === 0) {
        return;
    }
    const nextIndex = (activeConflictIndex + delta + conflicts.length) % conflicts.length;
    activeConflictIndex = nextIndex;
    scrollToConflict(nextIndex);
}

function jumpToNextUnhandledConflict() {
    if (conflicts.length === 0) {
        return;
    }
    for (let offset = 0; offset < conflicts.length; offset++) {
        const candidateIdx = (activeConflictIndex + offset) % conflicts.length;
        if (!conflicts[candidateIdx].handled) {
            activeConflictIndex = candidateIdx;
            scrollToConflict(candidateIdx);
            return;
        }
    }
    navigateConflict(1);
}

function scrollToConflict(conflictIndex: number) {
    if (!viewRootEl) {
        return;
    }
    const rowEl = viewRootEl.querySelector<HTMLElement>(`[data-testid="merge-conflict-row-${conflictIndex}"]`);
    rowEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const resultEl = viewRootEl.querySelector<HTMLElement>(`[data-testid="merge-result-hunk-${conflictIndex}"]`);
    resultEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function handleTopScroll() {
    if (isSyncingScroll || !topScrollEl || !resultScrollEl) {
        return;
    }
    const maxTop = topScrollEl.scrollHeight - topScrollEl.clientHeight;
    const maxResult = resultScrollEl.scrollHeight - resultScrollEl.clientHeight;
    if (maxTop <= 0 || maxResult <= 0) {
        return;
    }
    isSyncingScroll = true;
    const ratio = topScrollEl.scrollTop / maxTop;
    resultScrollEl.scrollTop = ratio * maxResult;
    requestAnimationFrame(() => {
        isSyncingScroll = false;
    });
}

function handleResultScroll() {
    if (isSyncingScroll || !topScrollEl || !resultScrollEl) {
        return;
    }
    const maxTop = topScrollEl.scrollHeight - topScrollEl.clientHeight;
    const maxResult = resultScrollEl.scrollHeight - resultScrollEl.clientHeight;
    if (maxTop <= 0 || maxResult <= 0) {
        return;
    }
    isSyncingScroll = true;
    const ratio = resultScrollEl.scrollTop / maxResult;
    topScrollEl.scrollTop = ratio * maxTop;
    requestAnimationFrame(() => {
        isSyncingScroll = false;
    });
}

function toggleRawEditMode() {
    if (!isRawEditMode) {
        rawTextContent = renderMergedContent(mergeDoc);
    } else {
        mergeDoc = syncMergeDocumentFromResultText(mergeDoc, rawTextContent);
    }
    isRawEditMode = !isRawEditMode;
}

async function handleCompleteMerge() {
    if (!onCompleteMerge || isCompleting) {
        return;
    }
    isCompleting = true;
    try {
        const finalContent = isRawEditMode ? rawTextContent : renderMergedContent(mergeDoc);
        await onCompleteMerge(finalContent);
    } finally {
        isCompleting = false;
    }
}

function handleKeydown(e: KeyboardEvent) {
    const modKey = e.ctrlKey || e.metaKey;
    if (modKey && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
        if (onSave) {
            e.preventDefault();
            const finalContent = isRawEditMode ? rawTextContent : renderMergedContent(mergeDoc);
            void onSave(finalContent);
        }
        return;
    }
    if (modKey && !e.shiftKey && !e.altKey && (e.key === 'l' || e.key === 'L' || e.key === 'i' || e.key === 'I')) {
        if (onAddSelectionToChat) {
            e.preventDefault();
            void onAddSelectionToChat();
        }
    }
}

function isLeftAccepted(resolution: ConflictResolution): boolean {
    return resolution === 'left' || resolution === 'both-left-first' || resolution === 'both-right-first';
}

function isRightAccepted(resolution: ConflictResolution): boolean {
    return resolution === 'right' || resolution === 'both-left-first' || resolution === 'both-right-first';
}

function formatLeftPrimaryActionLabel(hunk: MergeConflictHunk): string {
    if (isLeftAccepted(hunk.resolution)) {
        return '✓ Left Accepted';
    }
    if (hunk.resolution === 'right') {
        return 'Append Left';
    }
    return 'Accept Left';
}

function formatRightPrimaryActionLabel(hunk: MergeConflictHunk): string {
    if (isRightAccepted(hunk.resolution)) {
        return '✓ Right Accepted';
    }
    if (hunk.resolution === 'left') {
        return 'Append Right';
    }
    return 'Accept Right';
}

function formatCombinationLabel(hunk: MergeConflictHunk, firstSide: 'left' | 'right'): string {
    if (!hunk.isOrderRelevant) {
        return 'Accept Combination';
    }
    return firstSide === 'left' ? 'Accept Combination (Left First)' : 'Accept Combination (Right First)';
}

function formatResolutionLabel(hunk: MergeConflictHunk): string {
    switch (hunk.resolution) {
        case 'left':
            return 'Accepted Left';
        case 'right':
            return 'Accepted Right';
        case 'both-left-first':
            return hunk.isOrderRelevant ? 'Accepted Both (Left → Right)' : 'Accepted Combination';
        case 'both-right-first':
            return hunk.isOrderRelevant ? 'Accepted Both (Right → Left)' : 'Accepted Combination';
        case 'base':
            return 'No Changes Accepted (Handled)';
        case 'custom':
            return 'Manual Resolution';
        case 'unhandled':
            return 'No Changes Accepted';
    }
}

function getMaxLinesInSegment(segment: MergeConflictHunk | MergeCleanSegment, includeBase: boolean): number {
    const leftLen = Math.max(1, segment.leftLines.length);
    const rightLen = Math.max(1, segment.rightLines.length);
    const baseLen = includeBase ? Math.max(1, segment.baseLines.length) : 0;
    return Math.max(leftLen, rightLen, baseLen);
}

function toggleExpandContext(segmentId: string) {
    expandedContextIds = {
        ...expandedContextIds,
        [segmentId]: !expandedContextIds[segmentId],
    };
}

function extractTextareaSelection(
    textarea: HTMLTextAreaElement,
    baseStartLine: number,
): EditorChatContextSelection | null {
    if (textarea.selectionStart === textarea.selectionEnd) {
        return null;
    }
    const selectedText = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    if (!selectedText.trim()) {
        return null;
    }
    const beforeText = textarea.value.slice(0, textarea.selectionStart);
    const offsetLines = beforeText.split('\n').length - 1;
    const startLine = baseStartLine + offsetLines;
    const selectedLineCount = selectedText.split('\n').length;
    return {
        filePath,
        startLine,
        endLine: startLine + selectedLineCount - 1,
        selectedText,
    };
}

export function getCurrentResolvedContent(): string {
    return isRawEditMode ? rawTextContent : renderMergedContent(mergeDoc);
}

export function getChatContextSelection(): EditorChatContextSelection | null {
    if (!viewRootEl) {
        return null;
    }
    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLTextAreaElement && viewRootEl.contains(activeEl)) {
        const startAttr = activeEl.getAttribute('data-start-line');
        const baseStart = startAttr ? Number.parseInt(startAttr, 10) || 1 : 1;
        return extractTextareaSelection(activeEl, baseStart);
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return null;
    }
    const range = selection.getRangeAt(0);
    if (!viewRootEl.contains(range.commonAncestorContainer)) {
        return null;
    }
    const selectedText = selection.toString();
    if (!selectedText.trim()) {
        return null;
    }
    return {
        filePath,
        startLine: 1,
        endLine: Math.max(1, selectedText.split('\n').length),
        selectedText,
    };
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
    class="merge-editor-view"
    data-testid="merge-editor-view"
    bind:this={viewRootEl}
    onkeydown={handleKeydown}
    role="region"
    aria-label="3-Way Merge Editor"
>
    <!-- Top 35px Header Toolbar -->
    <div class="merge-toolbar" data-testid="merge-toolbar">
        <div class="merge-toolbar-left">
            <span class="merge-file-title" title={filePath}>{filePath}</span>
            <button
                type="button"
                class="merge-status-badge"
                class:resolved={unhandledConflictCount === 0}
                onclick={jumpToNextUnhandledConflict}
                title="Click to jump to next unhandled conflict"
                data-testid="merge-conflict-counter"
            >
                {#if unhandledConflictCount === 0}
                    All conflicts resolved
                {:else if unhandledConflictCount === 1}
                    1 conflict remaining
                {:else}
                    {unhandledConflictCount} conflicts remaining
                {/if}
            </button>
            {#if autoMergedCount > 0}
                <button
                    type="button"
                    class="merge-automerged-badge"
                    class:active={showNonConflicting}
                    onclick={() => (showNonConflicting = !showNonConflicting)}
                    title="Toggle visibility of non-conflicting auto-merged changes"
                    data-testid="merge-automerged-counter"
                >
                    {autoMergedCount} auto-merged
                </button>
            {/if}
        </div>

        <div class="merge-toolbar-actions">
            {#if conflicts.length > 0}
                <div class="merge-nav-group">
                    <button
                        type="button"
                        class="toolbar-btn"
                        onclick={() => navigateConflict(-1)}
                        title="Previous Conflict"
                        data-testid="merge-prev-conflict"
                    >
                        ↑ Prev
                    </button>
                    <button
                        type="button"
                        class="toolbar-btn"
                        onclick={() => navigateConflict(1)}
                        title="Next Conflict"
                        data-testid="merge-next-conflict"
                    >
                        ↓ Next
                    </button>
                </div>

                <div class="merge-bulk-group">
                    <button
                        type="button"
                        class="toolbar-btn"
                        onclick={() => handleAcceptAll('left')}
                        title="Accept Left (Current) for all conflicts"
                        data-testid="merge-accept-all-left"
                    >
                        Accept All Left
                    </button>
                    <button
                        type="button"
                        class="toolbar-btn"
                        onclick={() => handleAcceptAll('right')}
                        title="Accept Right (Incoming) for all conflicts"
                        data-testid="merge-accept-all-right"
                    >
                        Accept All Right
                    </button>
                </div>
            {/if}

            <button
                type="button"
                class="toolbar-btn"
                class:active={showBase}
                onclick={() => (showBase = !showBase)}
                title="Toggle Base (Common Ancestor) column"
                data-testid="merge-toggle-base"
            >
                Base
            </button>

            {#if onOpenTwoWayDiff}
                <button
                    type="button"
                    class="toolbar-btn"
                    onclick={onOpenTwoWayDiff}
                    title="Switch to 2-Way Diff View"
                    data-testid="merge-open-2way-diff"
                >
                    2-Way Diff
                </button>
            {/if}

            {#if onCompleteMerge}
                <button
                    type="button"
                    class="complete-merge-btn"
                    class:all-resolved={unhandledConflictCount === 0}
                    disabled={isCompleting}
                    onclick={handleCompleteMerge}
                    data-testid="merge-complete-btn"
                >
                    {isCompleting ? 'Saving...' : 'Complete Merge'}
                </button>
            {/if}
        </div>
    </div>

    <!-- Top Side-by-Side Input Panes (Left | optional Base | Right) -->
    <div class="merge-top-section" data-testid="merge-top-panes">
        <div class="merge-column-headers" class:with-base={showBase}>
            <div class="column-header left-header" data-testid="merge-header-left">
                <span class="column-title">{leftLabel}</span>
            </div>
            {#if showBase}
                <div class="column-header base-header" data-testid="merge-header-base">
                    <span class="column-title">{baseLabel}</span>
                </div>
            {/if}
            <div class="column-header right-header" data-testid="merge-header-right">
                <span class="column-title">{rightLabel}</span>
            </div>
        </div>

        <div class="merge-segments-scroll" bind:this={topScrollEl} onscroll={handleTopScroll}>
            {#each mergeDoc.segments as segment (segment.id)}
                {#if segment.type === 'clean' && segment.origin === 'unchanged'}
                    {@const isCollapsible = segment.lines.length > COLLAPSE_THRESHOLD}
                    {@const isExpanded = !!expandedContextIds[segment.id]}
                    {#if isCollapsible && !isExpanded}
                        {@const topLines = segment.lines.slice(0, CONTEXT_PADDING)}
                        {@const bottomLines = segment.lines.slice(segment.lines.length - CONTEXT_PADDING)}
                        {@const hiddenCount = segment.lines.length - CONTEXT_PADDING * 2}
                        <div class="segment-row common-row" class:with-base={showBase}>
                            <div class="side-cell">
                                {#each topLines as line, idx}
                                    <div class="code-line">
                                        <span class="gutter-checkbox-spacer"></span>
                                        <span class="line-num">{segment.leftRange.startLine + idx}</span>
                                        <span class="line-text">{line}</span>
                                    </div>
                                {/each}
                            </div>
                            {#if showBase}
                                <div class="side-cell base-cell">
                                    {#each topLines as line, idx}
                                        <div class="code-line">
                                            <span class="line-num">{segment.baseRange.startLine + idx}</span>
                                            <span class="line-text">{line}</span>
                                        </div>
                                    {/each}
                                </div>
                            {/if}
                            <div class="side-cell">
                                {#each topLines as line, idx}
                                    <div class="code-line">
                                        <span class="gutter-checkbox-spacer"></span>
                                        <span class="line-num">{segment.rightRange.startLine + idx}</span>
                                        <span class="line-text">{line}</span>
                                    </div>
                                {/each}
                            </div>
                        </div>
                        <div class="collapsed-context-bar">
                            <button
                                type="button"
                                class="expand-context-btn"
                                onclick={() => toggleExpandContext(segment.id)}
                            >
                                ⋯ Show {hiddenCount} unchanged lines ⋯
                            </button>
                        </div>
                        <div class="segment-row common-row" class:with-base={showBase}>
                            <div class="side-cell">
                                {#each bottomLines as line, idx}
                                    <div class="code-line">
                                        <span class="gutter-checkbox-spacer"></span>
                                        <span class="line-num">
                                            {segment.leftRange.startLine + segment.lines.length - CONTEXT_PADDING + idx}
                                        </span>
                                        <span class="line-text">{line}</span>
                                    </div>
                                {/each}
                            </div>
                            {#if showBase}
                                <div class="side-cell base-cell">
                                    {#each bottomLines as line, idx}
                                        <div class="code-line">
                                            <span class="line-num">
                                                {segment.baseRange.startLine + segment.lines.length - CONTEXT_PADDING + idx}
                                            </span>
                                            <span class="line-text">{line}</span>
                                        </div>
                                    {/each}
                                </div>
                            {/if}
                            <div class="side-cell">
                                {#each bottomLines as line, idx}
                                    <div class="code-line">
                                        <span class="gutter-checkbox-spacer"></span>
                                        <span class="line-num">
                                            {segment.rightRange.startLine + segment.lines.length - CONTEXT_PADDING + idx}
                                        </span>
                                        <span class="line-text">{line}</span>
                                    </div>
                                {/each}
                            </div>
                        </div>
                    {:else}
                        <div class="segment-row common-row" class:with-base={showBase}>
                            <div class="side-cell">
                                {#each segment.lines as line, idx}
                                    <div class="code-line">
                                        <span class="gutter-checkbox-spacer"></span>
                                        <span class="line-num">{segment.leftRange.startLine + idx}</span>
                                        <span class="line-text">{line}</span>
                                    </div>
                                {/each}
                            </div>
                            {#if showBase}
                                <div class="side-cell base-cell">
                                    {#each segment.lines as line, idx}
                                        <div class="code-line">
                                            <span class="line-num">{segment.baseRange.startLine + idx}</span>
                                            <span class="line-text">{line}</span>
                                        </div>
                                    {/each}
                                </div>
                            {/if}
                            <div class="side-cell">
                                {#each segment.lines as line, idx}
                                    <div class="code-line">
                                        <span class="gutter-checkbox-spacer"></span>
                                        <span class="line-num">{segment.rightRange.startLine + idx}</span>
                                        <span class="line-text">{line}</span>
                                    </div>
                                {/each}
                            </div>
                        </div>
                    {/if}
                {:else if segment.type === 'clean'}
                    {@const maxAutoLines = getMaxLinesInSegment(segment, showBase)}
                    <div class="automerged-block" data-testid="merge-automerged-segment">
                        {#if showNonConflicting}
                            <div class="automerged-banner">
                                <span class="automerged-label">
                                    {#if segment.origin === 'left'}
                                        {segment.accepted ? '✓ Auto-merged change from Left' : '○ Ignored auto-merged change from Left'}
                                    {:else if segment.origin === 'right'}
                                        {segment.accepted ? '✓ Auto-merged change from Right' : '○ Ignored auto-merged change from Right'}
                                    {:else}
                                        {segment.accepted ? '✓ Auto-merged identical change from both sides' : '○ Ignored identical change'}
                                    {/if}
                                </span>
                                <button
                                    type="button"
                                    class="codelens-link"
                                    onclick={() => handleToggleAutoMerged(segment)}
                                    data-testid="merge-toggle-automerged-{segment.id}"
                                >
                                    {segment.accepted ? 'Revert to Base' : 'Accept Auto-Merge'}
                                </button>
                            </div>
                        {/if}
                        <div class="segment-row automerged-row" class:with-base={showBase}>
                            <div
                                class="side-cell"
                                class:automerged-active={segment.accepted && (segment.origin === 'left' || segment.origin === 'both-identical')}
                            >
                                {#if segment.leftLines.length === 0}
                                    <div class="empty-hunk-placeholder">(deleted / empty)</div>
                                {:else}
                                    {#each segment.leftLines as line, idx}
                                        {@const wordTokens = segment.leftWordDiff[idx]?.tokens}
                                        <div class="code-line">
                                            {#if idx === 0 && (segment.origin === 'left' || segment.origin === 'both-identical')}
                                                <button
                                                    type="button"
                                                    class="gutter-checkbox"
                                                    class:checked={segment.accepted}
                                                    onclick={() => handleToggleAutoMerged(segment)}
                                                    title={segment.accepted ? 'Uncheck to revert auto-merged change' : 'Check to accept auto-merged change'}
                                                    aria-label="Toggle auto-merged Left change"
                                                    aria-checked={segment.accepted}
                                                    role="checkbox"
                                                    data-testid="merge-automerged-checkbox-{segment.id}"
                                                >
                                                    {segment.accepted ? '✓' : ''}
                                                </button>
                                            {:else}
                                                <span class="gutter-checkbox-spacer"></span>
                                            {/if}
                                            <span class="line-num">{segment.leftRange.startLine + idx}</span>
                                            <span class="line-text">
                                                {#if wordTokens && wordTokens.length > 0 && (segment.origin === 'left' || segment.origin === 'both-identical')}
                                                    {#each wordTokens as tok}
                                                        <span class:word-diff-changed={tok.changed}>{tok.text}</span>
                                                    {/each}
                                                {:else}
                                                    {line}
                                                {/if}
                                            </span>
                                        </div>
                                    {/each}
                                {/if}
                                {#if Math.max(1, segment.leftLines.length) < maxAutoLines}
                                    <div
                                        class="alignment-spacer"
                                        style="height: {(maxAutoLines - Math.max(1, segment.leftLines.length)) * 19}px;"
                                    ></div>
                                {/if}
                            </div>
                            {#if showBase}
                                <div class="side-cell base-cell">
                                    {#if segment.baseLines.length === 0}
                                        <div class="empty-hunk-placeholder">(empty in base)</div>
                                    {:else}
                                        {#each segment.baseLines as line, idx}
                                            <div class="code-line">
                                                <span class="line-num">{segment.baseRange.startLine + idx}</span>
                                                <span class="line-text">{line}</span>
                                            </div>
                                        {/each}
                                    {/if}
                                    {#if Math.max(1, segment.baseLines.length) < maxAutoLines}
                                        <div
                                            class="alignment-spacer"
                                            style="height: {(maxAutoLines - Math.max(1, segment.baseLines.length)) * 19}px;"
                                        ></div>
                                    {/if}
                                </div>
                            {/if}
                            <div
                                class="side-cell"
                                class:automerged-active={segment.accepted && (segment.origin === 'right' || segment.origin === 'both-identical')}
                            >
                                {#if segment.rightLines.length === 0}
                                    <div class="empty-hunk-placeholder">(deleted / empty)</div>
                                {:else}
                                    {#each segment.rightLines as line, idx}
                                        {@const wordTokens = segment.rightWordDiff[idx]?.tokens}
                                        <div class="code-line">
                                            {#if idx === 0 && (segment.origin === 'right' || segment.origin === 'both-identical')}
                                                <button
                                                    type="button"
                                                    class="gutter-checkbox"
                                                    class:checked={segment.accepted}
                                                    onclick={() => handleToggleAutoMerged(segment)}
                                                    title={segment.accepted ? 'Uncheck to revert auto-merged change' : 'Check to accept auto-merged change'}
                                                    aria-label="Toggle auto-merged Right change"
                                                    aria-checked={segment.accepted}
                                                    role="checkbox"
                                                    data-testid="merge-automerged-checkbox-right-{segment.id}"
                                                >
                                                    {segment.accepted ? '✓' : ''}
                                                </button>
                                            {:else}
                                                <span class="gutter-checkbox-spacer"></span>
                                            {/if}
                                            <span class="line-num">{segment.rightRange.startLine + idx}</span>
                                            <span class="line-text">
                                                {#if wordTokens && wordTokens.length > 0 && (segment.origin === 'right' || segment.origin === 'both-identical')}
                                                    {#each wordTokens as tok}
                                                        <span class:word-diff-changed={tok.changed}>{tok.text}</span>
                                                    {/each}
                                                {:else}
                                                    {line}
                                                {/if}
                                            </span>
                                        </div>
                                    {/each}
                                {/if}
                                {#if Math.max(1, segment.rightLines.length) < maxAutoLines}
                                    <div
                                        class="alignment-spacer"
                                        style="height: {(maxAutoLines - Math.max(1, segment.rightLines.length)) * 19}px;"
                                    ></div>
                                {/if}
                            </div>
                        </div>
                    </div>
                {:else if segment.type === 'conflict'}
                    {@const maxConflictLines = getMaxLinesInSegment(segment, showBase)}
                    <div
                        class="conflict-block"
                        class:active-conflict={activeConflictIndex === segment.index}
                        class:resolved-conflict={segment.handled}
                        data-testid="merge-conflict-row-{segment.index}"
                        onclick={() => (activeConflictIndex = segment.index)}
                        role="presentation"
                    >
                        <!-- Per-side VS Code style CodeLens conflict action bars -->
                        <div class="conflict-side-headers" class:with-base={showBase}>
                            <div class="conflict-side-bar left-conflict-bar">
                                <span class="conflict-hunk-label">
                                    Conflict #{segment.index + 1} — Left
                                </span>
                                <div class="conflict-side-btns">
                                    <button
                                        type="button"
                                        class="hunk-action-btn"
                                        class:accepted={isLeftAccepted(segment.resolution)}
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            toggleSideResolution(segment, 'left');
                                        }}
                                        data-testid="merge-accept-left-{segment.index}"
                                    >
                                        {formatLeftPrimaryActionLabel(segment)}
                                    </button>
                                    <button
                                        type="button"
                                        class="hunk-action-btn secondary"
                                        class:accepted={segment.resolution === 'both-left-first' || (!segment.isOrderRelevant && segment.resolution === 'both-right-first')}
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            applyResolution(segment.id, 'both-left-first');
                                        }}
                                        title="Combine changes from Left and Right (using token-level smart merge when non-overlapping)"
                                        data-testid="merge-accept-both-left-{segment.index}"
                                    >
                                        {formatCombinationLabel(segment, 'left')}
                                    </button>
                                    <button
                                        type="button"
                                        class="hunk-action-btn secondary"
                                        class:accepted={segment.leftHandled && !isLeftAccepted(segment.resolution)}
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            handleIgnoreSide(segment, 'left');
                                        }}
                                        title="Mark Left changes as handled without accepting them (Ignore)"
                                        data-testid="merge-ignore-left-{segment.index}"
                                    >
                                        {segment.leftHandled && !isLeftAccepted(segment.resolution) ? '✓ Ignored' : 'Ignore'}
                                    </button>
                                </div>
                            </div>

                            {#if showBase}
                                <div class="conflict-side-bar base-conflict-bar">
                                    <span class="conflict-hunk-label">Base</span>
                                </div>
                            {/if}

                            <div class="conflict-side-bar right-conflict-bar">
                                <span class="conflict-hunk-label">
                                    Conflict #{segment.index + 1} — Right
                                </span>
                                <div class="conflict-side-btns">
                                    <button
                                        type="button"
                                        class="hunk-action-btn"
                                        class:accepted={isRightAccepted(segment.resolution)}
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            toggleSideResolution(segment, 'right');
                                        }}
                                        data-testid="merge-accept-right-{segment.index}"
                                    >
                                        {formatRightPrimaryActionLabel(segment)}
                                    </button>
                                    <button
                                        type="button"
                                        class="hunk-action-btn secondary"
                                        class:accepted={segment.resolution === 'both-right-first' || (!segment.isOrderRelevant && segment.resolution === 'both-left-first')}
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            applyResolution(
                                                segment.id,
                                                segment.isOrderRelevant ? 'both-right-first' : 'both-left-first',
                                            );
                                        }}
                                        title="Combine changes from Right and Left (using token-level smart merge when non-overlapping)"
                                        data-testid="merge-accept-both-right-{segment.index}"
                                    >
                                        {formatCombinationLabel(segment, 'right')}
                                    </button>
                                    <button
                                        type="button"
                                        class="hunk-action-btn secondary"
                                        class:accepted={segment.rightHandled && !isRightAccepted(segment.resolution)}
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            handleIgnoreSide(segment, 'right');
                                        }}
                                        title="Mark Right changes as handled without accepting them (Ignore)"
                                        data-testid="merge-ignore-right-{segment.index}"
                                    >
                                        {segment.rightHandled && !isRightAccepted(segment.resolution) ? '✓ Ignored' : 'Ignore'}
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- Side-by-side conflict lines with Gutter Checkboxes and Word-Level Diffs -->
                        <div class="segment-row conflict-row" class:with-base={showBase}>
                            <div
                                class="side-cell left-conflict-cell"
                                class:side-selected={isLeftAccepted(segment.resolution)}
                                class:side-handled={segment.leftHandled}
                                data-testid="merge-left-hunk-{segment.index}"
                            >
                                {#if segment.leftLines.length === 0}
                                    <div class="code-line">
                                        <button
                                            type="button"
                                            class="gutter-checkbox"
                                            class:checked={isLeftAccepted(segment.resolution)}
                                            class:manual={segment.resolution === 'custom'}
                                            onclick={(e) => {
                                                e.stopPropagation();
                                                toggleSideResolution(segment, 'left');
                                            }}
                                            aria-label="Accept Left changes for conflict {segment.index + 1}"
                                            aria-checked={isLeftAccepted(segment.resolution)}
                                            role="checkbox"
                                            data-testid="merge-checkbox-left-{segment.index}"
                                        >
                                            {isLeftAccepted(segment.resolution) ? '✓' : segment.resolution === 'custom' ? '●' : ''}
                                        </button>
                                        <span class="empty-hunk-placeholder">(deleted on Left)</span>
                                    </div>
                                {:else}
                                    {#each segment.leftLines as line, idx}
                                        {@const wordTokens = segment.leftWordDiff[idx]?.tokens}
                                        <div class="code-line">
                                            {#if idx === 0}
                                                <button
                                                    type="button"
                                                    class="gutter-checkbox"
                                                    class:checked={isLeftAccepted(segment.resolution)}
                                                    class:manual={segment.resolution === 'custom'}
                                                    onclick={(e) => {
                                                        e.stopPropagation();
                                                        toggleSideResolution(segment, 'left');
                                                    }}
                                                    aria-label="Accept Left changes for conflict {segment.index + 1}"
                                                    aria-checked={isLeftAccepted(segment.resolution)}
                                                    role="checkbox"
                                                    data-testid="merge-checkbox-left-{segment.index}"
                                                >
                                                    {isLeftAccepted(segment.resolution) ? '✓' : segment.resolution === 'custom' ? '●' : ''}
                                                </button>
                                            {:else}
                                                <span class="gutter-checkbox-spacer"></span>
                                            {/if}
                                            <span class="line-num">{segment.leftRange.startLine + idx}</span>
                                            <span class="line-text">
                                                {#if wordTokens && wordTokens.length > 0}
                                                    {#each wordTokens as tok}
                                                        <span
                                                            class:word-diff-changed={tok.changed}
                                                            data-testid={tok.changed ? 'merge-word-diff' : undefined}
                                                        >{tok.text}</span>
                                                    {/each}
                                                {:else}
                                                    {line}
                                                {/if}
                                            </span>
                                        </div>
                                    {/each}
                                {/if}
                                {#if Math.max(1, segment.leftLines.length) < maxConflictLines}
                                    <div
                                        class="alignment-spacer"
                                        style="height: {(maxConflictLines - Math.max(1, segment.leftLines.length)) * 19}px;"
                                    ></div>
                                {/if}
                            </div>

                            {#if showBase}
                                <div
                                    class="side-cell base-cell"
                                    data-testid="merge-base-hunk-{segment.index}"
                                >
                                    {#if segment.baseLines.length === 0}
                                        <div class="empty-hunk-placeholder">(empty in Base)</div>
                                    {:else}
                                        {#each segment.baseLines as line, idx}
                                            <div class="code-line">
                                                <span class="line-num">{segment.baseRange.startLine + idx}</span>
                                                <span class="line-text">{line}</span>
                                            </div>
                                        {/each}
                                    {/if}
                                    {#if Math.max(1, segment.baseLines.length) < maxConflictLines}
                                        <div
                                            class="alignment-spacer"
                                            style="height: {(maxConflictLines - Math.max(1, segment.baseLines.length)) * 19}px;"
                                        ></div>
                                    {/if}
                                </div>
                            {/if}

                            <div
                                class="side-cell right-conflict-cell"
                                class:side-selected={isRightAccepted(segment.resolution)}
                                class:side-handled={segment.rightHandled}
                                data-testid="merge-right-hunk-{segment.index}"
                            >
                                {#if segment.rightLines.length === 0}
                                    <div class="code-line">
                                        <button
                                            type="button"
                                            class="gutter-checkbox"
                                            class:checked={isRightAccepted(segment.resolution)}
                                            class:manual={segment.resolution === 'custom'}
                                            onclick={(e) => {
                                                e.stopPropagation();
                                                toggleSideResolution(segment, 'right');
                                            }}
                                            aria-label="Accept Right changes for conflict {segment.index + 1}"
                                            aria-checked={isRightAccepted(segment.resolution)}
                                            role="checkbox"
                                            data-testid="merge-checkbox-right-{segment.index}"
                                        >
                                            {isRightAccepted(segment.resolution) ? '✓' : segment.resolution === 'custom' ? '●' : ''}
                                        </button>
                                        <span class="empty-hunk-placeholder">(deleted on Right)</span>
                                    </div>
                                {:else}
                                    {#each segment.rightLines as line, idx}
                                        {@const wordTokens = segment.rightWordDiff[idx]?.tokens}
                                        <div class="code-line">
                                            {#if idx === 0}
                                                <button
                                                    type="button"
                                                    class="gutter-checkbox"
                                                    class:checked={isRightAccepted(segment.resolution)}
                                                    class:manual={segment.resolution === 'custom'}
                                                    onclick={(e) => {
                                                        e.stopPropagation();
                                                        toggleSideResolution(segment, 'right');
                                                    }}
                                                    aria-label="Accept Right changes for conflict {segment.index + 1}"
                                                    aria-checked={isRightAccepted(segment.resolution)}
                                                    role="checkbox"
                                                    data-testid="merge-checkbox-right-{segment.index}"
                                                >
                                                    {isRightAccepted(segment.resolution) ? '✓' : segment.resolution === 'custom' ? '●' : ''}
                                                </button>
                                            {:else}
                                                <span class="gutter-checkbox-spacer"></span>
                                            {/if}
                                            <span class="line-num">{segment.rightRange.startLine + idx}</span>
                                            <span class="line-text">
                                                {#if wordTokens && wordTokens.length > 0}
                                                    {#each wordTokens as tok}
                                                        <span
                                                            class:word-diff-changed={tok.changed}
                                                            data-testid={tok.changed ? 'merge-word-diff' : undefined}
                                                        >{tok.text}</span>
                                                    {/each}
                                                {:else}
                                                    {line}
                                                {/if}
                                            </span>
                                        </div>
                                    {/each}
                                {/if}
                                {#if Math.max(1, segment.rightLines.length) < maxConflictLines}
                                    <div
                                        class="alignment-spacer"
                                        style="height: {(maxConflictLines - Math.max(1, segment.rightLines.length)) * 19}px;"
                                    ></div>
                                {/if}
                            </div>
                        </div>
                    </div>
                {/if}
            {/each}
        </div>
    </div>

    <!-- Bottom Result Pane (Continuous Document with Line Numbers & Inline Conflict CodeLenses) -->
    <div class="merge-result-section" data-testid="merge-pane-result">
        <div class="result-header">
            <div class="result-header-left">
                <span class="result-title">Result (Merged Output)</span>
                <span class="result-subtitle">
                    {#if isRawEditMode}
                        Editing full result document ({resultPreviewText.split('\n').length} lines)
                    {:else}
                        {resultPreviewText.split('\n').length} lines
                    {/if}
                </span>
            </div>
            <div class="result-header-actions">
                <button
                    type="button"
                    class="toolbar-btn"
                    class:active={isRawEditMode}
                    onclick={toggleRawEditMode}
                    data-testid="merge-toggle-raw-edit"
                >
                    {isRawEditMode ? 'Structured Result View' : 'Edit Full Result'}
                </button>
            </div>
        </div>

        {#if isRawEditMode}
            <div class="raw-editor-container">
                <textarea
                    class="raw-result-textarea"
                    value={rawTextContent}
                    oninput={(e) => handleRawEditorInput((e.currentTarget as HTMLTextAreaElement).value)}
                    spellcheck="false"
                    data-start-line="1"
                    data-testid="merge-raw-textarea"
                ></textarea>
            </div>
        {:else}
            <div class="result-segments-scroll" bind:this={resultScrollEl} onscroll={handleResultScroll}>
                {#each mergeDoc.segments as segment (segment.id)}
                    {#if segment.type === 'clean' && segment.origin === 'unchanged'}
                        <div class="result-common-segment">
                            {#each segment.lines as line, idx}
                                <div class="code-line">
                                    <span class="line-num">{segment.resultRange.startLine + idx}</span>
                                    <span class="line-text">{line}</span>
                                </div>
                            {/each}
                        </div>
                    {:else if segment.type === 'clean'}
                        <div
                            class="result-automerged-segment"
                            class:automerged-reverted={!segment.accepted}
                            data-testid="merge-result-automerged"
                        >
                            {#each segment.lines as line, idx}
                                <div class="code-line" class:automerged-result-line={segment.accepted}>
                                    <span class="line-num">{segment.resultRange.startLine + idx}</span>
                                    <span class="line-text">{line}</span>
                                </div>
                            {/each}
                        </div>
                    {:else if segment.type === 'conflict'}
                        <div
                            class="result-conflict-segment"
                            class:unhandled={!segment.handled}
                            class:resolved={segment.handled}
                            data-testid="merge-result-hunk-{segment.index}"
                        >
                            <div class="result-conflict-bar">
                                <span
                                    class="result-conflict-status"
                                    data-testid="merge-result-status-{segment.index}"
                                >
                                    Conflict #{segment.index + 1}: {formatResolutionLabel(segment)}
                                </span>
                                <div class="result-conflict-actions">
                                    <button
                                        type="button"
                                        class="hunk-action-btn"
                                        class:accepted={segment.resolution === 'left'}
                                        onclick={() => applyResolution(segment.id, 'left')}
                                        data-testid="merge-result-accept-left-{segment.index}"
                                    >
                                        Accept Left
                                    </button>
                                    <button
                                        type="button"
                                        class="hunk-action-btn"
                                        class:accepted={segment.resolution === 'right'}
                                        onclick={() => applyResolution(segment.id, 'right')}
                                        data-testid="merge-result-accept-right-{segment.index}"
                                    >
                                        Accept Right
                                    </button>
                                    <button
                                        type="button"
                                        class="hunk-action-btn secondary"
                                        class:accepted={segment.resolution === 'both-left-first'}
                                        onclick={() => applyResolution(segment.id, 'both-left-first')}
                                        data-testid="merge-result-accept-both-left-{segment.index}"
                                    >
                                        {segment.isOrderRelevant ? 'Both (L→R)' : 'Accept Combination'}
                                    </button>
                                    {#if segment.isOrderRelevant}
                                        <button
                                            type="button"
                                            class="hunk-action-btn secondary"
                                            class:accepted={segment.resolution === 'both-right-first'}
                                            onclick={() => applyResolution(segment.id, 'both-right-first')}
                                            data-testid="merge-result-accept-both-right-{segment.index}"
                                        >
                                            Both (R→L)
                                        </button>
                                    {/if}
                                    {#if segment.resolution === 'unhandled' || segment.resolution === 'base'}
                                        <button
                                            type="button"
                                            class="hunk-action-btn secondary"
                                            class:accepted={segment.handled}
                                            onclick={() => handleToggleHandled(segment)}
                                            title="Mark conflict as handled while keeping Base lines"
                                            data-testid="merge-result-toggle-handled-{segment.index}"
                                        >
                                            {segment.handled ? '✓ Handled' : 'Mark as Handled'}
                                        </button>
                                    {/if}
                                    {#if segment.resolution !== 'unhandled' || segment.handled}
                                        <button
                                            type="button"
                                            class="hunk-action-btn secondary"
                                            onclick={() => applyResolution(segment.id, 'unhandled')}
                                            data-testid="merge-result-reset-{segment.index}"
                                        >
                                            Reset to Base
                                        </button>
                                    {/if}
                                </div>
                            </div>

                            <div class="result-hunk-editor-row">
                                <div class="result-hunk-gutter" aria-hidden="true">
                                    {#each Array.from({ length: Math.max(1, segment.resolvedLines.length) }) as _, idx}
                                        <div class="gutter-line-num">{segment.resultRange.startLine + idx}</div>
                                    {/each}
                                </div>
                                <div class="result-hunk-editor-wrap">
                                    <textarea
                                        class="result-hunk-textarea"
                                        rows={Math.max(1, segment.resolvedLines.length)}
                                        value={segment.resolvedLines.join('\n')}
                                        oninput={(e) =>
                                            handleCustomHunkInput(segment, (e.currentTarget as HTMLTextAreaElement).value)}
                                        spellcheck="false"
                                        placeholder="(empty resolution — type custom lines or click Accept Left / Right / Combination)"
                                        data-start-line={segment.resultRange.startLine}
                                        data-testid="merge-hunk-editor-{segment.index}"
                                    ></textarea>
                                </div>
                            </div>
                        </div>
                    {/if}
                {/each}
            </div>
        {/if}
    </div>
</div>

<style>
    .merge-editor-view {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        background-color: var(--vscode-editor-background);
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        overflow: hidden;
    }

    .merge-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 35px;
        min-height: 35px;
        padding: 0 12px;
        background-color: var(--vscode-editorGroupHeader-tabsBackground);
        border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder);
        gap: 10px;
        flex-shrink: 0;
    }

    .merge-toolbar-left {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        overflow: hidden;
    }

    .merge-file-title {
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .merge-status-badge {
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        font-family: var(--vscode-font-family);
        background-color: var(--vscode-inputValidation-warningBackground, var(--vscode-badge-background));
        color: var(--vscode-badge-foreground);
        border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-widget-border));
        white-space: nowrap;
        cursor: pointer;
    }

    .merge-status-badge.resolved {
        background-color: var(--vscode-diffEditor-insertedTextBackground);
        color: var(--vscode-foreground);
        border-color: var(--vscode-widget-border);
    }

    .merge-automerged-badge {
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-family: var(--vscode-font-family);
        background-color: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        border: 1px solid transparent;
        white-space: nowrap;
        cursor: pointer;
    }

    .merge-automerged-badge.active {
        border-color: var(--vscode-focusBorder);
    }

    .merge-toolbar-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
    }

    .merge-nav-group,
    .merge-bulk-group {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .toolbar-btn {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: 1px solid var(--vscode-widget-border);
        border-radius: 4px;
        padding: 3px 8px;
        font-size: 11px;
        font-family: var(--vscode-font-family);
        cursor: pointer;
        white-space: nowrap;
    }

    .toolbar-btn:hover {
        background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .toolbar-btn.active {
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
        border-color: var(--vscode-focusBorder);
    }

    .complete-merge-btn {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: 1px solid transparent;
        border-radius: 4px;
        padding: 4px 12px;
        font-size: 11px;
        font-weight: 600;
        font-family: var(--vscode-font-family);
        cursor: pointer;
        white-space: nowrap;
    }

    .complete-merge-btn:hover:not(:disabled) {
        background-color: var(--vscode-button-hoverBackground);
    }

    .complete-merge-btn:disabled {
        opacity: 0.6;
        cursor: default;
    }

    /* Top comparison area */
    .merge-top-section {
        display: flex;
        flex-direction: column;
        flex: 1 1 55%;
        min-height: 160px;
        border-bottom: 2px solid var(--vscode-widget-border);
        overflow: hidden;
    }

    .merge-column-headers {
        display: grid;
        grid-template-columns: 1fr 1fr;
        height: 28px;
        min-height: 28px;
        background-color: var(--vscode-sideBar-background);
        border-bottom: 1px solid var(--vscode-widget-border);
        flex-shrink: 0;
    }

    .merge-column-headers.with-base {
        grid-template-columns: 1fr 1fr 1fr;
    }

    .column-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0 10px;
        font-size: 11px;
        font-weight: 600;
        border-right: 1px solid var(--vscode-widget-border);
        overflow: hidden;
    }

    .column-header:last-child {
        border-right: none;
    }

    .left-header {
        background-color: var(--vscode-merge-currentHeaderBackground);
    }

    .right-header {
        background-color: var(--vscode-merge-incomingHeaderBackground);
    }

    .column-title {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .merge-segments-scroll {
        flex: 1;
        overflow: auto;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size, 12px);
    }

    .segment-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        border-bottom: 1px solid var(--vscode-editorGroup-border, var(--vscode-widget-border));
    }

    .segment-row.with-base {
        grid-template-columns: 1fr 1fr 1fr;
    }

    .side-cell {
        min-width: 0;
        border-right: 1px solid var(--vscode-widget-border);
        padding: 2px 0;
        overflow-x: auto;
    }

    .side-cell:last-child {
        border-right: none;
    }

    .base-cell {
        background-color: var(--vscode-sideBar-background);
    }

    .code-line {
        display: flex;
        align-items: center;
        min-height: 19px;
        line-height: 19px;
        padding: 0 8px 0 4px;
        white-space: pre;
    }

    .gutter-checkbox,
    .gutter-checkbox-spacer {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        min-width: 16px;
        height: 16px;
        margin-right: 4px;
        flex-shrink: 0;
    }

    .gutter-checkbox {
        border: 1px solid var(--vscode-checkbox-border, var(--vscode-widget-border));
        border-radius: 3px;
        background-color: var(--vscode-checkbox-background, var(--vscode-input-background));
        color: var(--vscode-checkbox-foreground, var(--vscode-foreground));
        font-size: 11px;
        line-height: 1;
        padding: 0;
        cursor: pointer;
        user-select: none;
    }

    .gutter-checkbox:hover {
        border-color: var(--vscode-focusBorder);
    }

    .gutter-checkbox.checked {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: var(--vscode-button-background);
    }

    .gutter-checkbox.manual {
        border-color: var(--vscode-focusBorder);
        color: var(--vscode-focusBorder);
    }

    .line-num {
        display: inline-block;
        width: 32px;
        min-width: 32px;
        color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
        text-align: right;
        padding-right: 10px;
        user-select: none;
        font-size: 11px;
    }

    .line-text {
        flex: 1;
        white-space: pre;
    }

    .word-diff-changed {
        background-color: var(--vscode-diffEditor-insertedTextBackground);
        border-radius: 2px;
        outline: 1px solid var(--vscode-widget-border);
    }

    .alignment-spacer {
        width: 100%;
        background-image: repeating-linear-gradient(
            -45deg,
            transparent,
            transparent 4px,
            var(--vscode-sideBar-background) 4px,
            var(--vscode-sideBar-background) 8px
        );
        opacity: 0.5;
    }

    .collapsed-context-bar {
        display: flex;
        justify-content: center;
        padding: 2px 8px;
        background-color: var(--vscode-sideBar-background);
        border-bottom: 1px solid var(--vscode-widget-border);
    }

    .expand-context-btn {
        background: transparent;
        color: var(--vscode-descriptionForeground);
        border: 1px solid var(--vscode-widget-border);
        border-radius: 4px;
        padding: 1px 10px;
        font-size: 11px;
        cursor: pointer;
    }

    .expand-context-btn:hover {
        background-color: var(--vscode-list-hoverBackground);
        color: var(--vscode-foreground);
    }

    /* Auto-merged segment styling */
    .automerged-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2px 10px;
        font-size: 11px;
        background-color: var(--vscode-sideBar-background);
        color: var(--vscode-descriptionForeground);
        border-bottom: 1px solid var(--vscode-widget-border);
    }

    .codelens-link {
        background: transparent;
        border: none;
        color: var(--vscode-textLink-foreground, var(--vscode-foreground));
        font-size: 11px;
        font-family: var(--vscode-font-family);
        cursor: pointer;
        padding: 1px 4px;
        border-radius: 3px;
    }

    .codelens-link:hover {
        background-color: var(--vscode-list-hoverBackground);
    }

    .automerged-active {
        background-color: var(--vscode-diffEditor-insertedTextBackground);
    }

    .empty-hunk-placeholder {
        padding: 2px 8px;
        font-style: italic;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
    }

    /* Conflict block styling */
    .conflict-block {
        border-top: 1px solid var(--vscode-focusBorder);
        border-bottom: 1px solid var(--vscode-focusBorder);
        margin: 2px 0;
    }

    .conflict-block.active-conflict {
        outline: 1px solid var(--vscode-focusBorder);
    }

    .conflict-side-headers {
        display: grid;
        grid-template-columns: 1fr 1fr;
        background-color: var(--vscode-editorGroupHeader-tabsBackground);
        border-bottom: 1px solid var(--vscode-widget-border);
    }

    .conflict-side-headers.with-base {
        grid-template-columns: 1fr 1fr 1fr;
    }

    .conflict-side-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 8px;
        gap: 6px;
        border-right: 1px solid var(--vscode-widget-border);
        min-width: 0;
        white-space: nowrap;
        overflow-x: auto;
    }

    .conflict-side-bar:last-child {
        border-right: none;
    }

    .left-conflict-bar {
        background-color: var(--vscode-merge-currentHeaderBackground);
    }

    .right-conflict-bar {
        background-color: var(--vscode-merge-incomingHeaderBackground);
    }

    .conflict-hunk-label {
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .conflict-side-btns {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
        white-space: nowrap;
    }

    .hunk-action-btn {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: 1px solid var(--vscode-widget-border);
        border-radius: 4px;
        padding: 2px 7px;
        font-size: 11px;
        font-family: var(--vscode-font-family);
        cursor: pointer;
        white-space: nowrap;
    }

    .hunk-action-btn:hover {
        background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .hunk-action-btn.accepted {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: var(--vscode-focusBorder);
    }

    .left-conflict-cell {
        background-color: var(--vscode-merge-currentContentBackground);
    }

    .right-conflict-cell {
        background-color: var(--vscode-merge-incomingContentBackground);
    }

    .side-selected {
        box-shadow: inset 3px 0 0 var(--vscode-focusBorder);
    }

    /* Bottom Result Section */
    .merge-result-section {
        display: flex;
        flex-direction: column;
        flex: 1 1 45%;
        min-height: 150px;
        overflow: hidden;
        background-color: var(--vscode-editor-background);
    }

    .result-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 35px;
        min-height: 35px;
        padding: 0 12px;
        background-color: var(--vscode-editorGroupHeader-tabsBackground);
        border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder);
        flex-shrink: 0;
    }

    .result-header-left {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .result-title {
        font-weight: 600;
        font-size: 12px;
    }

    .result-subtitle {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }

    .result-segments-scroll {
        flex: 1;
        overflow: auto;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size, 12px);
        padding-bottom: 16px;
    }

    .automerged-result-line {
        background-color: var(--vscode-diffEditor-insertedTextBackground);
    }

    .result-conflict-segment {
        margin: 2px 0;
        border-top: 1px solid var(--vscode-widget-border);
        border-bottom: 1px solid var(--vscode-widget-border);
        overflow: hidden;
    }

    .result-conflict-segment.unhandled {
        border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder));
    }

    .result-conflict-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 3px 10px;
        background-color: var(--vscode-sideBar-background);
        border-bottom: 1px solid var(--vscode-widget-border);
        gap: 8px;
        flex-wrap: wrap;
    }

    .result-conflict-status {
        font-size: 11px;
        font-weight: 600;
        font-family: var(--vscode-font-family);
    }

    .result-conflict-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
    }

    .result-hunk-editor-row {
        display: flex;
        align-items: stretch;
        background-color: var(--vscode-input-background);
    }

    .result-hunk-gutter {
        display: flex;
        flex-direction: column;
        padding: 4px 0;
        background-color: var(--vscode-editor-background);
        border-right: 1px solid var(--vscode-widget-border);
        user-select: none;
        flex-shrink: 0;
    }

    .gutter-line-num {
        width: 36px;
        min-width: 36px;
        height: 19px;
        line-height: 19px;
        text-align: right;
        padding-right: 10px;
        font-size: 11px;
        color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
    }

    .result-hunk-editor-wrap {
        flex: 1;
        min-width: 0;
        background-color: var(--vscode-input-background);
    }

    .result-hunk-textarea {
        width: 100%;
        box-sizing: border-box;
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: none;
        padding: 4px 8px;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size, 12px);
        line-height: 19px;
        resize: vertical;
    }

    .result-hunk-textarea:focus {
        outline: 1px solid var(--vscode-focusBorder);
    }

    .raw-editor-container {
        flex: 1;
        display: flex;
        padding: 8px;
        overflow: hidden;
    }

    .raw-result-textarea {
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border);
        border-radius: 6px;
        padding: 8px 10px;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size, 12px);
        line-height: 19px;
        resize: none;
    }

    .raw-result-textarea:focus {
        outline: 1px solid var(--vscode-focusBorder);
    }
</style>
