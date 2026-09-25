<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { Snippet } from 'svelte';

interface Props {
    direction?: 'horizontal' | 'vertical';
    initialSize?: number;
    minSize?: number;
    maxSize?: number;
    left?: Snippet;
    right?: Snippet;
}

let { direction = 'horizontal', initialSize = 340, minSize = 180, maxSize = 800, left, right }: Props = $props();

// svelte-ignore state_referenced_locally
let size = $state(initialSize);
let isDragging = $state(false);

function handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) {
        return;
    }
    e.preventDefault();
    isDragging = true;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    const startPos = direction === 'horizontal' ? e.clientX : e.clientY;
    const startSize = size;

    function handlePointerMove(moveEvent: PointerEvent): void {
        const currentPos = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
        const delta = currentPos - startPos;
        size = Math.max(minSize, Math.min(maxSize, startSize + delta));
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
    }

    target.addEventListener('pointermove', handlePointerMove);
    target.addEventListener('pointerup', handlePointerUp);
    target.addEventListener('pointercancel', handlePointerUp);
}

function handleKeyDown(e: KeyboardEvent): void {
    const step = 10;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        size = Math.max(minSize, size - step);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        size = Math.min(maxSize, size + step);
    } else if (e.key === 'Home') {
        e.preventDefault();
        size = minSize;
    } else if (e.key === 'End') {
        e.preventDefault();
        size = maxSize;
    }
}
</script>

<div class={`split-container ${direction}`} class:resizing={isDragging} data-testid="split-pane">
    <div
        class="split-pane left-pane"
        style={direction === 'horizontal' ? `width: ${size}px; flex-shrink: 0;` : `height: ${size}px; flex-shrink: 0;`}
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
        aria-valuenow={size}
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        onpointerdown={handlePointerDown}
        onkeydown={handleKeyDown}
    ></div>

    <div class="split-pane right-pane">
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

.split-container.horizontal .left-pane {
    height: 100%;
    min-width: 0;
}

.split-container.vertical .left-pane {
    width: 100%;
    min-height: 0;
}

.split-container.horizontal .right-pane {
    flex-grow: 1;
    height: 100%;
    min-width: 0;
    overflow: hidden;
}

.split-container.vertical .right-pane {
    flex-grow: 1;
    width: 100%;
    min-height: 0;
    overflow: hidden;
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
