<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { Snippet } from 'svelte';
import SplitPane from './SplitPane.svelte';

interface Props {
    repoPath?: string;
    onRefresh?: () => void;
    scm?: Snippet;
    log?: Snippet;
    main?: Snippet;
    statusBar?: Snippet;
    activeTabId?: string;
}

let { scm, log, main, statusBar, activeTabId }: Props = $props();

let containerEl: HTMLElement | null = $state(null);
let isNarrow = $state(false);
type NarrowView = 'scm' | 'log' | 'diff';
let activeNarrowView = $state<NarrowView>('scm');

$effect(() => {
    if (!containerEl) {
        return;
    }
    const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
            isNarrow = entry.contentRect.width < 500;
        }
    });
    observer.observe(containerEl);
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
    <main class="app-main-content">
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
                        {@render log?.()}
                    {:else if activeNarrowView === 'diff'}
                        {@render main?.()}
                    {/if}
                </div>
            </div>
        {:else}
            <SplitPane direction="horizontal" initialSize={340} minSize={220} maxSize={650}>
                {#snippet left()}
                    <SplitPane direction="vertical" initialSize={380} minSize={150} maxSize={800}>
                        {#snippet left()}
                            {@render scm?.()}
                        {/snippet}
                        {#snippet right()}
                            {@render log?.()}
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
