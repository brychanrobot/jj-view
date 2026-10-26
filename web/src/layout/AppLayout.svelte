<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { Snippet } from 'svelte';
import type { PersistedLayout } from './layout-state';
import SplitPane from './SplitPane.svelte';

/** Parameters handed to the `log` snippet so the pane can drive auto-sizing and collapse. */
export interface LogPaneLayout {
    collapsed: boolean;
    /** Absent when the pane cannot be collapsed (narrow layout). */
    onToggleCollapsed?: () => void;
    /** Reports the pane's natural height (header + all rows) for automatic sizing. */
    onPreferredHeightChange?: (height: number) => void;
}

/** In the narrow layout the log owns the whole pane; it is neither sized nor collapsible. */
const NARROW_LOG_LAYOUT: LogPaneLayout = { collapsed: false };

interface Props {
    repoPath?: string;
    onRefresh?: () => void;
    scm?: Snippet;
    log?: Snippet<[LogPaneLayout]>;
    main?: Snippet;
    statusBar?: Snippet;
    activeTabId?: string;
    /** Sizes restored from storage; fields left undefined use automatic sizing. */
    layout?: PersistedLayout;
    /** Fired after a user gesture changes a persisted dimension. */
    onLayoutChange?: (layout: PersistedLayout) => void;
}

let { scm, log, main, statusBar, activeTabId, layout, onLayoutChange }: Props = $props();

const DEFAULT_SIDEBAR_WIDTH = 340;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 650;
/** The SCM pane keeps at least this much height no matter how far the log is dragged up. */
const MIN_SCM_HEIGHT = 100;
/** Height of the log header; what remains visible when the log is collapsed. */
const LOG_HEADER_HEIGHT = 35;
/** Dragging the log shorter than this snaps it to the collapsed header. */
const LOG_COLLAPSE_THRESHOLD = 80;
/** In automatic mode the log never takes more than this share of the window. */
const AUTO_LOG_MAX_FRACTION = 0.5;
/** Cap used for the first frame, before the container has been measured. */
const UNMEASURED_MAX_LOG_HEIGHT = 10000;

let containerEl: HTMLElement | null = $state(null);
let mainEl: HTMLElement | null = $state(null);
let isNarrow = $state(false);
let mainHeight = $state(0);
type NarrowView = 'scm' | 'log' | 'diff';
let activeNarrowView = $state<NarrowView>('scm');

// svelte-ignore state_referenced_locally
let sidebarWidth = $state(layout?.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH);
// Undefined until the user resizes the log; then it is respected verbatim.
// svelte-ignore state_referenced_locally
let userLogHeight = $state<number | undefined>(layout?.logHeight);
// svelte-ignore state_referenced_locally
let logCollapsed = $state(layout?.logCollapsed ?? false);
/** Natural height of the log pane (header + all rows), reported by the pane. */
let preferredLogHeight = $state(0);

const maxLogHeight = $derived(
    mainHeight > 0 ? Math.max(LOG_HEADER_HEIGHT, mainHeight - MIN_SCM_HEIGHT) : UNMEASURED_MAX_LOG_HEIGHT,
);
const autoLogHeight = $derived.by(() => {
    if (mainHeight <= 0) {
        return preferredLogHeight;
    }
    return Math.min(preferredLogHeight, mainHeight * AUTO_LOG_MAX_FRACTION);
});
const logHeight = $derived(Math.min(userLogHeight ?? autoLogHeight, maxLogHeight));

function emitLayoutChange(): void {
    onLayoutChange?.({
        sidebarWidth,
        logHeight: userLogHeight,
        logCollapsed,
    });
}

function toggleLogCollapsed(): void {
    logCollapsed = !logCollapsed;
    emitLayoutChange();
}

function setPreferredLogHeight(height: number): void {
    preferredLogHeight = height;
}

const logPaneLayout = $derived<LogPaneLayout>({
    collapsed: logCollapsed,
    onToggleCollapsed: toggleLogCollapsed,
    onPreferredHeightChange: setPreferredLogHeight,
});

$effect(() => {
    if (!containerEl) {
        return;
    }
    const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
            if (entry.target === containerEl) {
                isNarrow = entry.contentRect.width < 500;
            } else {
                mainHeight = entry.contentRect.height;
            }
        }
    });
    observer.observe(containerEl);
    if (mainEl) {
        observer.observe(mainEl);
    }
    return () => {
        observer.disconnect();
    };
});

let prevTabId: string | undefined;

$effect(() => {
    if (activeTabId && activeTabId !== prevTabId && isNarrow) {
        activeNarrowView = 'diff';
    } else if (!activeTabId && prevTabId && activeNarrowView === 'diff') {
        activeNarrowView = 'scm';
    }
    prevTabId = activeTabId;
});
</script>

<div class="app-shell" data-testid="app-shell" bind:this={containerEl}>
    <main class="app-main-content" bind:this={mainEl}>
        {#if isNarrow}
            <div class="narrow-layout" data-testid="narrow-layout">
                <div class="narrow-switcher" role="tablist" data-testid="narrow-switcher">
                    <button
                        type="button"
                        class="switcher-pill"
                        class:active={activeNarrowView === 'scm'}
                        role="tab"
                        aria-selected={activeNarrowView === 'scm'}
                        data-testid="pill-changes"
                        onclick={() => (activeNarrowView = 'scm')}
                    >
                        <i class="codicon codicon-source-control" aria-hidden="true"></i>
                        <span>Changes</span>
                    </button>
                    <button
                        type="button"
                        class="switcher-pill"
                        class:active={activeNarrowView === 'log'}
                        role="tab"
                        aria-selected={activeNarrowView === 'log'}
                        data-testid="pill-log"
                        onclick={() => (activeNarrowView = 'log')}
                    >
                        <i class="codicon codicon-history" aria-hidden="true"></i>
                        <span>Log</span>
                    </button>
                    <button
                        type="button"
                        class="switcher-pill"
                        class:active={activeNarrowView === 'diff'}
                        role="tab"
                        aria-selected={activeNarrowView === 'diff'}
                        data-testid="pill-diff"
                        onclick={() => (activeNarrowView = 'diff')}
                    >
                        <i class="codicon codicon-diff" aria-hidden="true"></i>
                        <span>Diff</span>
                    </button>
                </div>
                <div class="narrow-pane-content" data-testid="narrow-pane-content">
                    {#if activeNarrowView === 'scm'}
                        {@render scm?.()}
                    {:else if activeNarrowView === 'log'}
                        {@render log?.(NARROW_LOG_LAYOUT)}
                    {:else if activeNarrowView === 'diff'}
                        {@render main?.()}
                    {/if}
                </div>
            </div>
        {:else}
            <SplitPane
                direction="horizontal"
                size={sidebarWidth}
                minSize={MIN_SIDEBAR_WIDTH}
                maxSize={MAX_SIDEBAR_WIDTH}
                onResize={(size) => (sidebarWidth = size)}
                onResizeEnd={emitLayoutChange}
            >
                {#snippet left()}
                    <SplitPane
                        direction="vertical"
                        sizedPane="second"
                        size={logHeight}
                        minSize={LOG_HEADER_HEIGHT}
                        maxSize={maxLogHeight}
                        collapseThreshold={LOG_COLLAPSE_THRESHOLD}
                        collapsedSize={LOG_HEADER_HEIGHT}
                        collapsed={logCollapsed}
                        onResize={(size) => (userLogHeight = size)}
                        onCollapsedChange={(value) => (logCollapsed = value)}
                        onResizeEnd={emitLayoutChange}
                    >
                        {#snippet left()}
                            {@render scm?.()}
                        {/snippet}
                        {#snippet right()}
                            {@render log?.(logPaneLayout)}
                        {/snippet}
                    </SplitPane>
                {/snippet}
                {#snippet right()}
                    {@render main?.()}
                {/snippet}
            </SplitPane>
        {/if}
    </main>
    {#if statusBar}
        {@render statusBar()}
    {/if}
</div>

<style>
.app-shell {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background-color: var(--vscode-editor-background, #171717);
    color: var(--vscode-foreground, #d4d4d4);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    overflow: hidden;
}

.app-main-content {
    flex-grow: 1;
    height: 100%;
    width: 100%;
    min-height: 0;
    overflow: hidden;
    position: relative;
}

.narrow-layout {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
}

.narrow-switcher {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 35px;
    padding: 0 8px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground, #1e1e1e);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, var(--vscode-widget-border, #333333));
    box-sizing: border-box;
    user-select: none;
}

.switcher-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 10px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    font-family: inherit;
    font-size: var(--vscode-font-size, 13px);
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
}

.switcher-pill:hover {
    background-color: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
    color: var(--vscode-foreground, #d4d4d4);
}

.switcher-pill.active {
    background-color: var(--vscode-list-activeSelectionBackground, #04395e);
    color: var(--vscode-list-activeSelectionForeground, #ffffff);
    font-weight: 500;
}

.switcher-pill:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: -1px;
}

.narrow-pane-content {
    flex: 1;
    min-height: 0;
    width: 100%;
    overflow: hidden;
    position: relative;
}
</style>
