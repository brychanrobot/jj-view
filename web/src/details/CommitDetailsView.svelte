<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import CommitDetailsApp from '../../../src/core/webview/commit-details/CommitDetailsApp.svelte';
import { initBridge } from '../../../src/core/webview/transport/bridge.svelte';
import type { WebviewTransport } from '../../../src/core/webview/transport/types';

interface Props {
    transport: WebviewTransport;
    onClose?: () => void;
}

let { transport, onClose }: Props = $props();

initBridge(transport);
</script>

<div class="commit-details-view" data-testid="commit-details-view">
    <header class="details-header" data-testid="details-header">
        <span class="details-title">Commit Details</span>
        <div class="details-toolbar">
            <button
                type="button"
                class="icon-button close-button"
                data-testid="commit-details-close"
                title="Close"
                onclick={() => onClose?.()}
            >
                <i class="codicon codicon-close" aria-hidden="true"></i>
            </button>
        </div>
    </header>

    <div class="details-content" data-testid="commit-details-content">
        <CommitDetailsApp />
    </div>
</div>

<style>
.commit-details-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    min-height: 0;
    background-color: var(--vscode-editor-background, #171717);
    color: var(--vscode-foreground, #d4d4d4);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    overflow: hidden;
}

.details-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 35px;
    padding: 0 16px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground, #171717);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #1d1d1d);
    font-size: 12px;
    font-weight: 600;
    flex-shrink: 0;
}

.details-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.details-toolbar {
    display: flex;
    align-items: center;
}

.close-button {
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--vscode-icon-foreground, #8a8a8a);
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.close-button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(31, 62, 94, 0.45));
    color: var(--vscode-foreground);
}

.details-content {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
    height: 100%;
    display: flex;
    flex-direction: column;
}

:global(.details-content > .commit-details-container) {
    flex: 1 1 0;
    min-height: 0;
    height: 100%;
    overflow-y: auto;
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif);
    font-size: var(--vscode-font-size, 13px);
}
</style>
