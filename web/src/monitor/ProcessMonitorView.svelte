<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import ProcessMonitorApp from '../../../src/core/webview/process-monitor/ProcessMonitorApp.svelte';
import { initBridge } from '../../../src/core/webview/transport/bridge.svelte';
import type { WebviewTransport } from '../../../src/core/webview/transport/types';

interface Props {
    transport: WebviewTransport;
    onClose?: () => void;
}

let { transport, onClose }: Props = $props();

// svelte-ignore state_referenced_locally
initBridge(transport);
</script>

<div class="process-monitor-view" data-testid="process-monitor-view">
    <header class="monitor-pane-header" data-testid="process-monitor-header">
        <div class="header-left">
            <i class="codicon codicon-pulse" aria-hidden="true"></i>
            <span class="monitor-title">Process &amp; Performance Monitor</span>
        </div>
        <div class="monitor-toolbar">
            {#if onClose}
                <button
                    type="button"
                    class="icon-button close-button"
                    data-testid="process-monitor-close"
                    title="Close"
                    aria-label="Close"
                    onclick={() => onClose()}
                >
                    <i class="codicon codicon-close" aria-hidden="true"></i>
                </button>
            {/if}
        </div>
    </header>

    <div class="monitor-content" data-testid="process-monitor-content">
        <ProcessMonitorApp />
    </div>
</div>

<style>
.process-monitor-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    min-height: 0;
    background-color: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    overflow: hidden;
}

.monitor-pane-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 35px;
    padding: 0 12px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, var(--vscode-widget-border));
    font-size: 12px;
    font-weight: 600;
    flex-shrink: 0;
}

.header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.monitor-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.monitor-toolbar {
    display: flex;
    align-items: center;
}

.close-button {
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.close-button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-foreground);
}

.close-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
}

.monitor-content {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    height: 100%;
    display: flex;
    flex-direction: column;
}
</style>
