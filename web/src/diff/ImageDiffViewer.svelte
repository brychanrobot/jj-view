<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { formatByteSize, getDataUrlByteLength, toImageDataUrl } from './binary-detection';

export type ImageDiffMode = '2-up' | 'swipe' | 'onion' | 'difference';
export type ImageBackdropMode = 'checkerboard' | 'dark' | 'light';

interface ImageDimensions {
    readonly width: number;
    readonly height: number;
}

interface Props {
    filename: string;
    originalContent?: string;
    modifiedContent?: string;
    fileStatus?: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
    singleFile?: boolean;
    showHeader?: boolean;
    onSwitchToCode?: () => void;
}

let {
    filename,
    originalContent = '',
    modifiedContent = '',
    fileStatus,
    singleFile = false,
    showHeader = false,
    onSwitchToCode,
}: Props = $props();

const ZOOM_STEPS = [25, 50, 75, 100, 150, 200, 300, 400, 800] as const;

let mode = $state<ImageDiffMode>('2-up');
let swipePercent = $state(50);
let onionOpacity = $state(50);
let backdrop = $state<ImageBackdropMode>('checkerboard');
let zoomMode = $state<'fit' | 'custom'>('fit');
let zoomPercent = $state(100);
let isDraggingSwipe = $state(false);
let swipeStageEl = $state<HTMLDivElement | null>(null);

let originalDimensions = $state<ImageDimensions | null>(null);
let modifiedDimensions = $state<ImageDimensions | null>(null);
let originalLoadError = $state(false);
let modifiedLoadError = $state(false);

const cleanFilename = $derived(filename.replace(/\s*\([^)]*\)$/, '').trim());
const originalSrc = $derived(toImageDataUrl(originalContent, cleanFilename));
const modifiedSrc = $derived(toImageDataUrl(modifiedContent, cleanFilename));
const originalBytes = $derived(getDataUrlByteLength(originalContent));
const modifiedBytes = $derived(getDataUrlByteLength(modifiedContent));

const hasOriginal = $derived(!singleFile && fileStatus !== 'added' && Boolean(originalSrc));
const hasModified = $derived(singleFile ? Boolean(modifiedSrc) : fileStatus !== 'deleted' && Boolean(modifiedSrc));
const canCompare = $derived(hasOriginal && hasModified);
const effectiveMode = $derived<ImageDiffMode>(canCompare ? mode : '2-up');

const statusBadgeLabel = $derived.by((): string => {
    if (singleFile) {
        return 'Preview';
    }
    if (fileStatus === 'added' || (!hasOriginal && hasModified)) {
        return 'Added';
    }
    if (fileStatus === 'deleted' || (hasOriginal && !hasModified)) {
        return 'Deleted';
    }
    if (fileStatus === 'renamed') {
        return 'Renamed';
    }
    if (fileStatus === 'copied') {
        return 'Copied';
    }
    return 'Modified';
});

const statusBadgeKind = $derived.by((): 'added' | 'deleted' | 'modified' => {
    if (fileStatus === 'added' || (!hasOriginal && hasModified)) {
        return 'added';
    }
    if (fileStatus === 'deleted' || (hasOriginal && !hasModified)) {
        return 'deleted';
    }
    return 'modified';
});

const byteDeltaSummary = $derived.by((): { text: string; kind: 'added' | 'deleted' | 'neutral' } | null => {
    if (!canCompare) {
        return null;
    }
    const diff = modifiedBytes - originalBytes;
    if (diff === 0) {
        return { text: '0 B (0%)', kind: 'neutral' };
    }
    const sign = diff > 0 ? '+' : '-';
    const formatted = formatByteSize(Math.abs(diff));
    const pct = originalBytes > 0 ? ` (${sign}${((Math.abs(diff) / originalBytes) * 100).toFixed(1)}%)` : '';
    return {
        text: `${sign}${formatted}${pct}`,
        kind: diff > 0 ? 'added' : 'deleted',
    };
});

const dimensionSummary = $derived.by((): string | null => {
    if (!canCompare || !originalDimensions || !modifiedDimensions) {
        return null;
    }
    if (
        originalDimensions.width === modifiedDimensions.width &&
        originalDimensions.height === modifiedDimensions.height
    ) {
        return `${modifiedDimensions.width} × ${modifiedDimensions.height} px`;
    }
    return `${originalDimensions.width} × ${originalDimensions.height} px → ${modifiedDimensions.width} × ${modifiedDimensions.height} px`;
});

const overlayStageWidth = $derived.by((): number | undefined => {
    const origW = originalDimensions?.width ?? 0;
    const modW = modifiedDimensions?.width ?? 0;
    const maxW = Math.max(origW, modW);
    if (maxW <= 0) {
        return undefined;
    }
    if (zoomMode === 'custom') {
        return Math.max(1, Math.round((maxW * zoomPercent) / 100));
    }
    return maxW;
});

const overlayStageHeight = $derived.by((): number | undefined => {
    const origH = originalDimensions?.height ?? 0;
    const modH = modifiedDimensions?.height ?? 0;
    const maxH = Math.max(origH, modH);
    if (maxH <= 0) {
        return undefined;
    }
    if (zoomMode === 'custom') {
        return Math.max(1, Math.round((maxH * zoomPercent) / 100));
    }
    return maxH;
});

const isPixelated = $derived(
    (zoomMode === 'custom' && zoomPercent > 100) ||
        (originalDimensions !== null && originalDimensions.width <= 64 && originalDimensions.height <= 64) ||
        (modifiedDimensions !== null && modifiedDimensions.width <= 64 && modifiedDimensions.height <= 64),
);

$effect(() => {
    void originalSrc;
    originalDimensions = null;
    originalLoadError = false;
});

$effect(() => {
    void modifiedSrc;
    modifiedDimensions = null;
    modifiedLoadError = false;
});

function handleOriginalLoad(e: Event): void {
    const img = e.currentTarget as HTMLImageElement | null;
    if (!img) {
        return;
    }
    originalDimensions = {
        width: img.naturalWidth,
        height: img.naturalHeight,
    };
    originalLoadError = false;
}

function handleModifiedLoad(e: Event): void {
    const img = e.currentTarget as HTMLImageElement | null;
    if (!img) {
        return;
    }
    modifiedDimensions = {
        width: img.naturalWidth,
        height: img.naturalHeight,
    };
    modifiedLoadError = false;
}

function cycleBackdrop(): void {
    if (backdrop === 'checkerboard') {
        backdrop = 'dark';
        return;
    }
    if (backdrop === 'dark') {
        backdrop = 'light';
        return;
    }
    backdrop = 'checkerboard';
}

function setFitZoom(): void {
    zoomMode = 'fit';
    zoomPercent = 100;
}

function setActualSizeZoom(): void {
    zoomMode = 'custom';
    zoomPercent = 100;
}

function stepZoom(direction: -1 | 1): void {
    zoomMode = 'custom';
    if (direction > 0) {
        const next = ZOOM_STEPS.find((s) => s > zoomPercent);
        zoomPercent = next ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
        return;
    }
    const prev = [...ZOOM_STEPS].reverse().find((s) => s < zoomPercent);
    zoomPercent = prev ?? ZOOM_STEPS[0];
}

function updateSwipeFromClientX(clientX: number): void {
    if (!swipeStageEl) {
        return;
    }
    const rect = swipeStageEl.getBoundingClientRect();
    if (rect.width <= 0) {
        return;
    }
    const ratio = ((clientX - rect.left) / rect.width) * 100;
    swipePercent = Math.max(0, Math.min(100, Math.round(ratio)));
}

function handleSwipePointerDown(e: PointerEvent): void {
    isDraggingSwipe = true;
    updateSwipeFromClientX(e.clientX);
    if (e.currentTarget instanceof HTMLElement && typeof e.currentTarget.setPointerCapture === 'function') {
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            // Ignore pointer capture errors in synthetic test events
        }
    }
}

function handleSwipePointerMove(e: PointerEvent): void {
    if (!isDraggingSwipe) {
        return;
    }
    updateSwipeFromClientX(e.clientX);
}

function handleSwipePointerUp(): void {
    isDraggingSwipe = false;
}

function handleSwipeKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        swipePercent = Math.max(0, swipePercent - (e.shiftKey ? 10 : 2));
        return;
    }
    if (e.key === 'ArrowRight') {
        e.preventDefault();
        swipePercent = Math.min(100, swipePercent + (e.shiftKey ? 10 : 2));
    }
}

function computeScaledStyle(dims: ImageDimensions | null): string | undefined {
    if (zoomMode !== 'custom') {
        return undefined;
    }
    if (dims && dims.width > 0 && dims.height > 0) {
        const w = Math.max(1, Math.round((dims.width * zoomPercent) / 100));
        const h = Math.max(1, Math.round((dims.height * zoomPercent) / 100));
        return `width: ${w}px; height: ${h}px; max-width: none; max-height: none;`;
    }
    return `transform: scale(${zoomPercent / 100}); transform-origin: center center;`;
}
</script>

<div
    class="image-diff-viewer"
    data-testid={singleFile ? 'image-file-viewer' : 'image-diff-viewer'}
    data-mode={effectiveMode}
    data-backdrop={backdrop}
>
    {#if showHeader}
        <div class="image-diff-file-header" data-testid="image-diff-file-header">
            <div class="header-file-info">
                <i class="codicon codicon-file-media" aria-hidden="true"></i>
                <span class="header-filename">{cleanFilename}</span>
                <span class="status-pill status-{statusBadgeKind}" data-testid="image-diff-status-badge">
                    {statusBadgeLabel}
                </span>
            </div>
        </div>
    {/if}

    <div class="image-diff-toolbar" data-testid="image-diff-toolbar">
        <div class="toolbar-left">
            {#if !showHeader}
                <span class="status-pill status-{statusBadgeKind}" data-testid="image-diff-status-badge">
                    {statusBadgeLabel}
                </span>
            {/if}
            {#if dimensionSummary}
                <span class="meta-summary-item" data-testid="image-diff-dimension-summary">
                    <i class="codicon codicon-screen-full" aria-hidden="true"></i>
                    <span>{dimensionSummary}</span>
                </span>
            {/if}
            {#if byteDeltaSummary}
                <span
                    class="meta-delta-badge delta-{byteDeltaSummary.kind}"
                    data-testid="image-diff-byte-delta"
                    title="File size change"
                >
                    {byteDeltaSummary.text}
                </span>
            {/if}
        </div>

        <div class="toolbar-right">
            {#if effectiveMode === 'swipe'}
                <label class="inline-slider-control" data-testid="image-diff-swipe-control">
                    <span class="slider-label">Split</span>
                    <input
                        type="range"
                        min="0"
                        max="100"
                        bind:value={swipePercent}
                        class="toolbar-range-input"
                        data-testid="image-diff-swipe-slider"
                        aria-label="Swipe split percentage"
                    />
                    <span class="slider-value">{swipePercent}%</span>
                </label>
            {:else if effectiveMode === 'onion'}
                <label class="inline-slider-control" data-testid="image-diff-onion-control">
                    <span class="slider-label">Opacity</span>
                    <input
                        type="range"
                        min="0"
                        max="100"
                        bind:value={onionOpacity}
                        class="toolbar-range-input"
                        data-testid="image-diff-opacity-slider"
                        aria-label="Onion skin opacity"
                    />
                    <span class="slider-value">{onionOpacity}%</span>
                </label>
            {/if}

            <div class="segmented-group" role="group" aria-label="Zoom controls">
                <button
                    type="button"
                    class="seg-btn"
                    class:active={zoomMode === 'fit'}
                    onclick={setFitZoom}
                    title="Fit image to container"
                    data-testid="image-diff-zoom-fit"
                >
                    Fit
                </button>
                <button
                    type="button"
                    class="seg-btn"
                    class:active={zoomMode === 'custom' && zoomPercent === 100}
                    onclick={setActualSizeZoom}
                    title="Actual pixel size (100%)"
                    data-testid="image-diff-zoom-actual"
                >
                    1:1
                </button>
                <button
                    type="button"
                    class="seg-btn icon-only"
                    onclick={() => stepZoom(-1)}
                    title="Zoom out"
                    aria-label="Zoom out"
                    data-testid="image-diff-zoom-out"
                >
                    <i class="codicon codicon-zoom-out" aria-hidden="true"></i>
                </button>
                <span class="zoom-readout" data-testid="image-diff-zoom-readout">
                    {zoomMode === 'fit' ? 'Fit' : `${zoomPercent}%`}
                </span>
                <button
                    type="button"
                    class="seg-btn icon-only"
                    onclick={() => stepZoom(1)}
                    title="Zoom in"
                    aria-label="Zoom in"
                    data-testid="image-diff-zoom-in"
                >
                    <i class="codicon codicon-zoom-in" aria-hidden="true"></i>
                </button>
            </div>

            <button
                type="button"
                class="backdrop-btn"
                onclick={cycleBackdrop}
                title="Cycle canvas background (Checkerboard / Dark / Light)"
                data-testid="image-diff-bg-toggle"
            >
                <i class="codicon codicon-color-mode" aria-hidden="true"></i>
                <span class="backdrop-label">{backdrop === 'checkerboard' ? 'Grid' : backdrop === 'dark' ? 'Dark' : 'Light'}</span>
            </button>

            {#if canCompare}
                <div class="segmented-group" role="group" aria-label="Image comparison mode">
                    <button
                        type="button"
                        class="seg-btn"
                        class:active={effectiveMode === '2-up'}
                        onclick={() => {
                            mode = '2-up';
                        }}
                        title="Side-by-side 2-up comparison"
                        data-testid="image-diff-mode-2up"
                    >
                        2-Up
                    </button>
                    <button
                        type="button"
                        class="seg-btn"
                        class:active={effectiveMode === 'swipe'}
                        onclick={() => {
                            mode = 'swipe';
                        }}
                        title="Interactive swipe slider comparison"
                        data-testid="image-diff-mode-swipe"
                    >
                        Swipe
                    </button>
                    <button
                        type="button"
                        class="seg-btn"
                        class:active={effectiveMode === 'onion'}
                        onclick={() => {
                            mode = 'onion';
                        }}
                        title="Onion skin opacity blend"
                        data-testid="image-diff-mode-onion"
                    >
                        Onion
                    </button>
                    <button
                        type="button"
                        class="seg-btn"
                        class:active={effectiveMode === 'difference'}
                        onclick={() => {
                            mode = 'difference';
                        }}
                        title="Pixel difference highlight"
                        data-testid="image-diff-mode-difference"
                    >
                        Diff
                    </button>
                </div>
            {/if}

            {#if onSwitchToCode}
                <button
                    type="button"
                    class="backdrop-btn"
                    onclick={onSwitchToCode}
                    title="Switch to source code diff"
                    data-testid="image-diff-switch-to-code"
                >
                    <i class="codicon codicon-code" aria-hidden="true"></i>
                    <span>Code</span>
                </button>
            {/if}
        </div>
    </div>

    <div class="image-diff-body">
        {#if effectiveMode === '2-up'}
            <div class="two-up-grid" class:single-pane={!canCompare} data-testid="image-diff-2up-grid">
                {#if hasOriginal}
                    <section class="image-pane pane-before" data-testid="image-pane-before">
                        <header class="pane-header">
                            <span class="pane-side-badge side-before">Before</span>
                            <div class="pane-meta" data-testid="image-meta-before">
                                {#if originalDimensions}
                                    <span>{originalDimensions.width} × {originalDimensions.height} px</span>
                                    <span class="meta-sep">•</span>
                                {/if}
                                <span>{formatByteSize(originalBytes)}</span>
                            </div>
                        </header>
                        <div class="pane-canvas backdrop-{backdrop}" class:fit-mode={zoomMode === 'fit'}>
                            {#if originalLoadError}
                                <div class="image-load-error" data-testid="image-error-before">
                                    <i class="codicon codicon-warning" aria-hidden="true"></i>
                                    <span>Unable to decode image preview ({formatByteSize(originalBytes)})</span>
                                </div>
                            {:else}
                                <img
                                    src={originalSrc}
                                    alt={`Before: ${cleanFilename}`}
                                    class="diff-image"
                                    class:pixelated={isPixelated}
                                    style={computeScaledStyle(originalDimensions)}
                                    onload={handleOriginalLoad}
                                    onerror={() => {
                                        originalLoadError = true;
                                    }}
                                    draggable="false"
                                    data-testid="image-before"
                                />
                            {/if}
                        </div>
                    </section>
                {/if}

                {#if hasModified}
                    <section
                        class="image-pane"
                        class:pane-after={!singleFile}
                        class:pane-single={singleFile}
                        data-testid={singleFile ? 'image-pane-single' : 'image-pane-after'}
                    >
                        <header class="pane-header">
                            <span class="pane-side-badge" class:side-after={!singleFile}>
                                {singleFile ? cleanFilename : 'After'}
                            </span>
                            <div class="pane-meta" data-testid="image-meta-after">
                                {#if modifiedDimensions}
                                    <span>{modifiedDimensions.width} × {modifiedDimensions.height} px</span>
                                    <span class="meta-sep">•</span>
                                {/if}
                                <span>{formatByteSize(modifiedBytes)}</span>
                            </div>
                        </header>
                        <div class="pane-canvas backdrop-{backdrop}" class:fit-mode={zoomMode === 'fit'}>
                            {#if modifiedLoadError}
                                <div class="image-load-error" data-testid="image-error-after">
                                    <i class="codicon codicon-warning" aria-hidden="true"></i>
                                    <span>Unable to decode image preview ({formatByteSize(modifiedBytes)})</span>
                                </div>
                            {:else}
                                <img
                                    src={modifiedSrc}
                                    alt={singleFile ? cleanFilename : `After: ${cleanFilename}`}
                                    class="diff-image"
                                    class:pixelated={isPixelated}
                                    style={computeScaledStyle(modifiedDimensions)}
                                    onload={handleModifiedLoad}
                                    onerror={() => {
                                        modifiedLoadError = true;
                                    }}
                                    draggable="false"
                                    data-testid="image-after"
                                />
                            {/if}
                        </div>
                    </section>
                {/if}
            </div>
        {:else if effectiveMode === 'swipe'}
            <div class="overlay-mode-wrapper" data-testid="image-diff-swipe-view">
                <div class="overlay-header">
                    <span class="pane-side-badge side-before">
                        Before ({originalDimensions ? `${originalDimensions.width}×${originalDimensions.height} px, ` : ''}{formatByteSize(originalBytes)})
                    </span>
                    <span class="overlay-instruction">Drag handle or use Left/Right arrows to compare</span>
                    <span class="pane-side-badge side-after">
                        After ({modifiedDimensions ? `${modifiedDimensions.width}×${modifiedDimensions.height} px, ` : ''}{formatByteSize(modifiedBytes)})
                    </span>
                </div>
                <div class="overlay-canvas-viewport backdrop-{backdrop}">
                    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <div
                        bind:this={swipeStageEl}
                        class="swipe-stage"
                        class:fit-mode={zoomMode === 'fit'}
                        style:width={overlayStageWidth ? `${overlayStageWidth}px` : undefined}
                        style:height={overlayStageHeight ? `${overlayStageHeight}px` : undefined}
                        role="slider"
                        tabindex="0"
                        aria-label="Image swipe comparison divider"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={swipePercent}
                        onpointerdown={handleSwipePointerDown}
                        onpointermove={handleSwipePointerMove}
                        onpointerup={handleSwipePointerUp}
                        onpointercancel={handleSwipePointerUp}
                        onkeydown={handleSwipeKeydown}
                        data-testid="image-diff-swipe-stage"
                    >
                        <img
                            src={modifiedSrc}
                            alt={`After: ${cleanFilename}`}
                            class="overlay-img overlay-after-base"
                            class:pixelated={isPixelated}
                            onload={handleModifiedLoad}
                            draggable="false"
                            data-testid="image-swipe-after"
                        />
                        <img
                            src={originalSrc}
                            alt={`Before: ${cleanFilename}`}
                            class="overlay-img overlay-before-clipped"
                            class:pixelated={isPixelated}
                            style:clip-path={`inset(0 ${100 - swipePercent}% 0 0)`}
                            onload={handleOriginalLoad}
                            draggable="false"
                            data-testid="image-swipe-before"
                        />
                        <div
                            class="swipe-divider-line"
                            style:left={`${swipePercent}%`}
                            data-testid="image-diff-swipe-handle"
                        >
                            <div class="swipe-divider-knob">
                                <i class="codicon codicon-grabber" aria-hidden="true"></i>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        {:else if effectiveMode === 'onion'}
            <div class="overlay-mode-wrapper" data-testid="image-diff-onion-view">
                <div class="overlay-header">
                    <span class="pane-side-badge side-before">Before (0%)</span>
                    <span class="overlay-instruction">Blending After at {onionOpacity}% opacity</span>
                    <span class="pane-side-badge side-after">After (100%)</span>
                </div>
                <div class="overlay-canvas-viewport backdrop-{backdrop}">
                    <div
                        class="overlay-stage"
                        class:fit-mode={zoomMode === 'fit'}
                        style:width={overlayStageWidth ? `${overlayStageWidth}px` : undefined}
                        style:height={overlayStageHeight ? `${overlayStageHeight}px` : undefined}
                        data-testid="image-diff-onion-stage"
                    >
                        <img
                            src={originalSrc}
                            alt={`Before: ${cleanFilename}`}
                            class="overlay-img overlay-base"
                            class:pixelated={isPixelated}
                            onload={handleOriginalLoad}
                            draggable="false"
                            data-testid="image-onion-before"
                        />
                        <img
                            src={modifiedSrc}
                            alt={`After: ${cleanFilename}`}
                            class="overlay-img overlay-top"
                            class:pixelated={isPixelated}
                            style:opacity={onionOpacity / 100}
                            onload={handleModifiedLoad}
                            draggable="false"
                            data-testid="image-onion-after"
                        />
                    </div>
                </div>
            </div>
        {:else if effectiveMode === 'difference'}
            <div class="overlay-mode-wrapper" data-testid="image-diff-difference-view">
                <div class="overlay-header">
                    <span class="pane-side-badge side-before">Before</span>
                    <span class="overlay-instruction">
                        Identical pixels appear dark; changed pixels are highlighted
                    </span>
                    <span class="pane-side-badge side-after">After</span>
                </div>
                <div class="overlay-canvas-viewport backdrop-dark">
                    <div
                        class="overlay-stage difference-isolation"
                        class:fit-mode={zoomMode === 'fit'}
                        style:width={overlayStageWidth ? `${overlayStageWidth}px` : undefined}
                        style:height={overlayStageHeight ? `${overlayStageHeight}px` : undefined}
                        data-testid="image-diff-difference-stage"
                    >
                        <img
                            src={originalSrc}
                            alt={`Before: ${cleanFilename}`}
                            class="overlay-img overlay-base"
                            class:pixelated={isPixelated}
                            onload={handleOriginalLoad}
                            draggable="false"
                            data-testid="image-difference-before"
                        />
                        <img
                            src={modifiedSrc}
                            alt={`After: ${cleanFilename}`}
                            class="overlay-img overlay-top blend-difference"
                            class:pixelated={isPixelated}
                            onload={handleModifiedLoad}
                            draggable="false"
                            data-testid="image-difference-after"
                        />
                    </div>
                </div>
            </div>
        {/if}
    </div>
</div>

<style>
.image-diff-viewer {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 280px;
    background-color: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    overflow: hidden;
}

.image-diff-file-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 35px;
    padding: 0 12px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder);
    flex-shrink: 0;
}

.header-file-info {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.header-filename {
    font-weight: 600;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.image-diff-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 35px;
    padding: 4px 12px;
    background-color: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-widget-border);
    flex-wrap: wrap;
    flex-shrink: 0;
}

.toolbar-left,
.toolbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.status-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    border: 1px solid var(--vscode-widget-border);
    background-color: var(--vscode-input-background);
    color: var(--vscode-foreground);
}

.status-pill.status-added {
    border-color: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 50%, transparent);
    color: var(--vscode-gitDecoration-addedResourceForeground);
}

.status-pill.status-deleted {
    border-color: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground) 50%, transparent);
    color: var(--vscode-gitDecoration-deletedResourceForeground);
}

.status-pill.status-modified {
    border-color: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground) 50%, transparent);
    color: var(--vscode-gitDecoration-modifiedResourceForeground);
}

.meta-summary-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
}

.meta-delta-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    border: 1px solid var(--vscode-widget-border);
    background-color: var(--vscode-input-background);
    color: var(--vscode-descriptionForeground);
}

.meta-delta-badge.delta-added {
    color: var(--vscode-gitDecoration-addedResourceForeground);
}

.meta-delta-badge.delta-deleted {
    color: var(--vscode-gitDecoration-deletedResourceForeground);
}

.segmented-group {
    display: inline-flex;
    align-items: stretch;
    height: 24px;
    border: 1px solid var(--vscode-input-border);
    border-radius: 6px;
    background-color: var(--vscode-input-background);
    overflow: hidden;
}

.seg-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 8px;
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-font-family);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
}

.seg-btn.icon-only {
    padding: 0 6px;
}

.seg-btn:hover {
    color: var(--vscode-foreground);
    background-color: var(--vscode-list-hoverBackground);
}

.seg-btn.active {
    background-color: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    font-weight: 600;
}

.seg-btn:focus-visible,
.backdrop-btn:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
}

.zoom-readout {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 38px;
    padding: 0 4px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
    border-left: 1px solid var(--vscode-input-border);
    border-right: 1px solid var(--vscode-input-border);
}

.backdrop-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--vscode-input-border);
    border-radius: 6px;
    background-color: var(--vscode-input-background);
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-font-family);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
}

.backdrop-btn:hover {
    color: var(--vscode-foreground);
    background-color: var(--vscode-list-hoverBackground);
}

.inline-slider-control {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--vscode-input-border);
    border-radius: 6px;
    background-color: var(--vscode-input-background);
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

.slider-label {
    font-weight: 500;
}

.slider-value {
    min-width: 32px;
    text-align: right;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-foreground);
}

.toolbar-range-input {
    width: 84px;
    accent-color: var(--vscode-focusBorder);
    cursor: pointer;
}

.image-diff-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: auto;
    padding: 16px;
}

.two-up-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    flex: 1;
    min-height: 0;
}

.two-up-grid.single-pane {
    grid-template-columns: minmax(0, 1fr);
}

.image-pane {
    display: flex;
    flex-direction: column;
    min-height: 220px;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 6px;
    background-color: var(--vscode-sideBar-background);
    overflow: hidden;
}

.image-pane.pane-before {
    border-color: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground) 45%, var(--vscode-widget-border));
}

.image-pane.pane-after {
    border-color: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 45%, var(--vscode-widget-border));
}

.pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 35px;
    padding: 0 12px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder);
    flex-shrink: 0;
}

.pane-side-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-foreground);
}

.pane-side-badge.side-before {
    color: var(--vscode-gitDecoration-deletedResourceForeground);
}

.pane-side-badge.side-after {
    color: var(--vscode-gitDecoration-addedResourceForeground);
}

.pane-meta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
}

.meta-sep {
    opacity: 0.6;
}

.pane-canvas,
.overlay-canvas-viewport {
    flex: 1;
    min-height: 200px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 16px;
    position: relative;
}

.backdrop-checkerboard {
    background-color: var(--vscode-editor-background);
    background-image:
        linear-gradient(45deg, color-mix(in srgb, var(--vscode-foreground) 8%, transparent) 25%, transparent 25%),
        linear-gradient(-45deg, color-mix(in srgb, var(--vscode-foreground) 8%, transparent) 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--vscode-foreground) 8%, transparent) 75%),
        linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--vscode-foreground) 8%, transparent) 75%);
    background-size: 16px 16px;
    background-position:
        0 0,
        0 8px,
        8px -8px,
        -8px 0;
}

.backdrop-dark {
    background-color: color-mix(in srgb, var(--vscode-editor-background) 85%, black);
}

.backdrop-light {
    background-color: color-mix(in srgb, var(--vscode-foreground) 90%, white);
}

.diff-image {
    display: block;
    object-fit: contain;
    box-shadow: 0 2px 8px color-mix(in srgb, var(--vscode-widget-shadow, var(--vscode-widget-border)) 35%, transparent);
}

.pane-canvas.fit-mode .diff-image {
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
}

.diff-image.pixelated,
.overlay-img.pixelated {
    image-rendering: pixelated;
}

.image-load-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 24px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    text-align: center;
}

.overlay-mode-wrapper {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 240px;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 6px;
    background-color: var(--vscode-sideBar-background);
    overflow: hidden;
}

.overlay-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    height: 35px;
    padding: 0 12px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder);
    flex-shrink: 0;
}

.overlay-instruction {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
}

.swipe-stage,
.overlay-stage {
    position: relative;
    display: grid;
    place-items: center;
    user-select: none;
    max-width: 100%;
    max-height: 100%;
}

.swipe-stage {
    cursor: ew-resize;
    touch-action: none;
}

.swipe-stage:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
}

.overlay-img {
    grid-area: 1 / 1;
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
}

.swipe-divider-line {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    transform: translateX(-50%);
    background-color: var(--vscode-focusBorder);
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
}

.swipe-divider-knob {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background-color: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border: 1px solid var(--vscode-focusBorder);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
}

.difference-isolation {
    isolation: isolate;
    background-color: black;
}

.blend-difference {
    mix-blend-mode: difference;
}
</style>
