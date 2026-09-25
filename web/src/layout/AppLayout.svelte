<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { Snippet } from 'svelte';
import SplitPane from './SplitPane.svelte';

interface Props {
    repoPath?: string;
    activeTab?: 'scm' | 'log';
    onTabChange?: (tab: 'scm' | 'log') => void;
    onRefresh?: () => void;
    sidebar?: Snippet;
    main?: Snippet;
}

let { repoPath = '', activeTab = 'scm', onTabChange, onRefresh, sidebar, main }: Props = $props();

let isDarkMode = $state(true);

function toggleTheme(): void {
    isDarkMode = !isDarkMode;
    if (typeof document !== 'undefined') {
        document.documentElement.classList.toggle('vscode-light', !isDarkMode);
        document.documentElement.classList.toggle('vscode-dark', isDarkMode);
    }
}
</script>

<div class="app-shell" data-testid="app-shell">
    <header class="app-top-bar" data-testid="app-top-bar">
        <div class="left-section">
            <span class="app-logo">
                <i class="codicon codicon-git-merge" aria-hidden="true"></i>
                <span class="app-title">JJ VIEW</span>
            </span>

            {#if repoPath}
                <span class="repo-badge" title={repoPath}>
                    <i class="codicon codicon-repo" aria-hidden="true"></i>
                    <span>{repoPath.split('/').pop() || repoPath}</span>
                </span>
            {/if}

            <nav class="view-tabs" aria-label="Views">
                <button
                    type="button"
                    class="view-tab"
                    class:active={activeTab === 'scm'}
                    data-testid="tab-scm"
                    onclick={() => onTabChange?.('scm')}
                >
                    <i class="codicon codicon-source-control" aria-hidden="true"></i>
                    <span>Source Control</span>
                </button>

                <button
                    type="button"
                    class="view-tab"
                    class:active={activeTab === 'log'}
                    data-testid="tab-log"
                    onclick={() => onTabChange?.('log')}
                >
                    <i class="codicon codicon-git-commit" aria-hidden="true"></i>
                    <span>JJ Log</span>
                </button>
            </nav>
        </div>

        <div class="right-section">
            <button
                type="button"
                class="icon-button top-action-button"
                data-testid="app-refresh-button"
                title="Refresh"
                onclick={() => onRefresh?.()}
            >
                <i class="codicon codicon-refresh" aria-hidden="true"></i>
            </button>

            <button
                type="button"
                class="icon-button top-action-button"
                data-testid="app-theme-button"
                title="Toggle Theme"
                onclick={toggleTheme}
            >
                <i class={`codicon codicon-${isDarkMode ? 'sun' : 'moon'}`} aria-hidden="true"></i>
            </button>
        </div>
    </header>

    <main class="app-main-content">
        <SplitPane initialSize={320} minSize={200} maxSize={600}>
            {#snippet left()}
                {@render sidebar?.()}
            {/snippet}
            {#snippet right()}
                {@render main?.()}
            {/snippet}
        </SplitPane>
    </main>
</div>

<style>
.app-shell {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    background-color: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #cccccc);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    overflow: hidden;
}

.app-top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 36px;
    padding: 0 12px;
    background-color: var(--vscode-titleBar-activeBackground, #323233);
    color: var(--vscode-titleBar-activeForeground, #cccccc);
    border-bottom: 1px solid var(--vscode-titleBar-border, rgba(128, 128, 128, 0.2));
    user-select: none;
    flex-shrink: 0;
}

.left-section {
    display: flex;
    align-items: center;
    gap: 16px;
}

.app-logo {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 0.5px;
    color: var(--vscode-foreground, #ffffff);
}

.repo-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    background-color: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #ffffff);
    padding: 2px 8px;
    border-radius: 12px;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.view-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
}

.view-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--vscode-titleBar-activeForeground, #cccccc);
    font-family: inherit;
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
}

.view-tab:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
}

.view-tab.active {
    background-color: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
}

.right-section {
    display: flex;
    align-items: center;
    gap: 8px;
}

.top-action-button {
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--vscode-icon-foreground, #c5c5c5);
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.top-action-button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
    color: var(--vscode-foreground, #ffffff);
}

.app-main-content {
    flex-grow: 1;
    overflow: hidden;
    position: relative;
}
</style>
