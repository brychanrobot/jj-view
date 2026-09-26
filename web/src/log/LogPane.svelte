<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import LogApp from '../../../src/core/webview/log/LogApp.svelte';
import { initBridge } from '../../../src/core/webview/transport/bridge.svelte';
import type { WebviewTransport } from '../../../src/core/webview/transport/types';

interface Props {
    transport: WebviewTransport;
    onRefresh?: () => void;
}

let { transport, onRefresh }: Props = $props();

// svelte-ignore state_referenced_locally
initBridge(transport);
</script>

<div class="log-pane" data-testid="log-pane">
    <header class="log-header" data-testid="log-header">
        <span class="log-title">JJ LOG</span>
        <div class="log-toolbar" role="toolbar" aria-label="Log Actions">
            <button
                type="button"
                class="icon-button toolbar-button"
                data-testid="log-refresh-button"
                title="Refresh JJ Log"
                onclick={() => onRefresh?.()}
            >
                <i class="codicon codicon-refresh" aria-hidden="true"></i>
            </button>
        </div>
    </header>

    <div class="log-content" data-testid="log-content">
        <LogApp />
    </div>
</div>

<style>
.log-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    min-height: 0;
    background-color: var(--vscode-sideBar-background, #171717);
    color: var(--vscode-foreground, #d4d4d4);
    overflow: hidden;
}

.log-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 35px;
    padding: 0 16px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground, #171717);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #1d1d1d);
    border-top: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #1d1d1d);
    user-select: none;
    flex-shrink: 0;
    box-sizing: border-box;
}

.log-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.log-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
}

.toolbar-button {
    background: transparent;
    color: var(--vscode-icon-foreground, #8a8a8a);
    border: none;
    border-radius: 4px;
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    transition: background-color 0.15s, color 0.15s;
}

.toolbar-button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(31, 62, 94, 0.45));
    color: var(--vscode-foreground);
}

.log-content {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
    position: relative;
    height: 100%;
    display: flex;
    flex-direction: column;
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif);
    font-size: var(--vscode-font-size, 13px);
}

:global(.log-content > .app-container) {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    flex: 1 1 0;
    overflow: hidden;
}

:global(.log-content .scroll-container) {
    flex: 1 1 0 !important;
    height: 100% !important;
    min-height: 0 !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
}

:global(.log-content .commit-id) {
    font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace) !important;
    font-size: 12px !important;
}

:global(.log-content .commit-desc) {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground, #d4d4d4);
}
</style>
