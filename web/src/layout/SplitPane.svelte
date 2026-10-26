<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * Two-pane splitter. Controlled: the parent owns `size` (and `collapsed`) and
 * receives change requests, so it can persist them or derive the size from
 * content while the user has not resized yet.
 */
interface Props {
    direction?: 'horizontal' | 'vertical';
    /** Which pane has the fixed `size`; the other one fills the remainder. */
    sizedPane?: 'first' | 'second';
    /** Size of the sized pane in px (ignored while collapsed). */
    size: number;
    minSize?: number;
    maxSize?: number;
    /** When set, dragging the sized pane below this many px snaps it closed. */
    collapseThreshold?: number;
    /** Size of the sized pane while collapsed (e.g. just its header). */
    collapsedSize?: number;
    collapsed?: boolean;
    /** Called continuously while dragging / on keyboard steps. */
    onResize: (size: number) => void;
    onCollapsedChange?: (collapsed: boolean) => void;
    /** Called once when a user-initiated resize gesture finishes. */
    onResizeEnd?: () => void;
    left?: Snippet;
    right?: Snippet;
}

let {
    direction = 'horizontal',
    sizedPane = 'first',
    size,
    minSize = 0,
    maxSize = 800,
    collapseThreshold,
    collapsedSize = 0,
    collapsed = false,
    onResize,
    onCollapsedChange,
    onResizeEnd,
    left,
    right,
}: Props = $props();

let isDragging = $state(false);

const renderedSize = $derived(collapsed ? collapsedSize : Math.max(minSize, Math.min(maxSize, size)));
const sizedStyle = $derived(
    direction === 'horizontal'
        ? `width: ${renderedSize}px; flex-shrink: 0;`
        : `height: ${renderedSize}px; flex-shrink: 0;`,
);

function clamp(value: number): number {
    return Math.max(minSize, Math.min(maxSize, value));
}

/**
 * Applies a size the user asked for, snapping into / out of the collapsed
 * state when a threshold is configured. `restoreSize` is what the expanded
 * size should be remembered as if this request collapses the pane, so a
 * single drag from 300px to closed re-opens at 300px, not at the threshold.
 */
function requestSize(requested: number, restoreSize: number): void {
    const shouldCollapse = collapseThreshold !== undefined && requested < collapseThreshold;
    if (shouldCollapse) {
        if (!collapsed) {
            onCollapsedChange?.(true);
            if (restoreSize >= collapseThreshold) {
                onResize(clamp(restoreSize));
            }
        }
        return;
    }
    if (collapsed) {
        onCollapsedChange?.(false);
    }
    onResize(clamp(requested));
}

function handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) {
        return;
    }
    e.preventDefault();
    isDragging = true;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    const startPos = direction === 'horizontal' ? e.clientX : e.clientY;
    const startSize = renderedSize;
    // The remembered expanded size for a collapse that happens in this gesture.
    const restoreSize = collapsed ? size : startSize;
    // Moving the handle towards the end of the container grows the first pane
    // and shrinks the second.
    const sign = sizedPane === 'first' ? 1 : -1;

    function handlePointerMove(moveEvent: PointerEvent): void {
        const currentPos = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
        const delta = currentPos - startPos;
        requestSize(startSize + sign * delta, restoreSize);
    }

    function handlePointerUp(upEvent: PointerEvent): void {
        isDragging = false;
        try {
            target.releasePointerCapture(upEvent.pointerId);
        } catch {
            // Element may have detached
        }
        target.removeEventListener('pointermove', handlePointerMove);
        target.removeEventListener('pointerup', handlePointerUp);
        target.removeEventListener('pointercancel', handlePointerUp);
        onResizeEnd?.();
    }

    target.addEventListener('pointermove', handlePointerMove);
    target.addEventListener('pointerup', handlePointerUp);
    target.addEventListener('pointercancel', handlePointerUp);
}

function handleKeyDown(e: KeyboardEvent): void {
    const step = 10;
    const sign = sizedPane === 'first' ? 1 : -1;
    const current = renderedSize;
    let requested: number | undefined;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        requested = current - sign * step;
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        requested = current + sign * step;
    } else if (e.key === 'Home') {
        requested = sizedPane === 'first' ? minSize : maxSize;
    } else if (e.key === 'End') {
        requested = sizedPane === 'first' ? maxSize : minSize;
    }
    if (requested === undefined) {
        return;
    }
    e.preventDefault();
    requestSize(requested, collapsed ? size : current);
    onResizeEnd?.();
}
</script>

<div class={`split-container ${direction}`} class:resizing={isDragging} data-testid="split-pane">
    <div
        class="split-pane first-pane"
        class:sized={sizedPane === 'first'}
        class:fluid={sizedPane !== 'first'}
        style={sizedPane === 'first' ? sizedStyle : undefined}
    >
        {@render left?.()}
    </div>

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
        class="split-handle"
        data-testid="split-handle"
        role="separator"
        tabindex="0"
        aria-label="Resize panels"
        aria-orientation={direction}
        aria-valuenow={renderedSize}
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        onpointerdown={handlePointerDown}
        onkeydown={handleKeyDown}
    ></div>

    <div
        class="split-pane second-pane"
        class:sized={sizedPane === 'second'}
        class:fluid={sizedPane !== 'second'}
        style={sizedPane === 'second' ? sizedStyle : undefined}
    >
        {@render right?.()}
    </div>
</div>

<style>
.split-container {
    display: flex;
    width: 100%;
    height: 100%;
    overflow: hidden;
    position: relative;
}

.split-container.horizontal {
    flex-direction: row;
}

.split-container.vertical {
    flex-direction: column;
}

.split-pane {
    overflow: hidden;
    position: relative;
}

.split-container.horizontal .split-pane {
    height: 100%;
    min-width: 0;
}

.split-container.vertical .split-pane {
    width: 100%;
    min-height: 0;
}

.split-pane.fluid {
    flex-grow: 1;
}

.split-handle {
    background-color: var(--vscode-sideBar-border, #1d1d1d);
    transition: background-color 0.15s ease;
    z-index: 10;
    flex-shrink: 0;
    border: none;
    padding: 0;
    margin: 0;
    appearance: none;
}

.split-container.horizontal .split-handle {
    width: 4px;
    height: 100%;
    cursor: col-resize;
}

.split-container.vertical .split-handle {
    height: 4px;
    width: 100%;
    cursor: row-resize;
}

.split-handle:hover,
.split-container.resizing .split-handle {
    background-color: var(--vscode-focusBorder, #69b1ff);
}

.split-container.resizing {
    user-select: none;
}
</style>
