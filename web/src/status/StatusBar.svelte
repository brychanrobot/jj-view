<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import type { NotificationService } from '../notifications/notification-service';
import type { StatusBarService, StatusBarState } from './status-bar-service';

interface Props {
    service: StatusBarService;
    notificationService?: NotificationService;
    onOpenSettings?: () => void;
}

let { service, notificationService, onOpenSettings }: Props = $props();

// svelte-ignore state_referenced_locally
let state = $state<StatusBarState>(service.state);
// svelte-ignore state_referenced_locally
let notificationCount = $state<number>(notificationService?.items.length ?? 0);

let unsubscribeStatus: (() => void) | null = null;
let unsubscribeNotifications: (() => void) | null = null;

onMount(() => {
    state = service.state;
    const statusSub = service.onDidChangeStatus((newState) => {
        state = newState;
    });
    unsubscribeStatus = statusSub.dispose;

    if (notificationService) {
        notificationCount = notificationService.items.length;
        const notifSub = notificationService.onDidChangeNotifications((items) => {
            notificationCount = items.length;
        });
        unsubscribeNotifications = notifSub.dispose;
    }
});

onDestroy(() => {
    if (unsubscribeStatus) {
        unsubscribeStatus();
    }
    if (unsubscribeNotifications) {
        unsubscribeNotifications();
    }
});

const progress = $derived(state.progress);
const statusMessage = $derived(state.statusMessage);
const workingCopy = $derived(state.workingCopy);
const connection = $derived(state.connection);
</script>

<footer class="app-status-bar" data-testid="status-bar" role="status">
    <div class="status-section status-left">
        {#if workingCopy?.changeId}
            <div
                class="status-item working-copy-item"
                data-testid="status-working-copy"
                title={`Working Copy: ${workingCopy.changeId}${workingCopy.bookmark ? ` (${workingCopy.bookmark})` : ''}`}
            >
                <i class="codicon codicon-git-commit" aria-hidden="true"></i>
                <span class="status-label">{workingCopy.changeId.slice(0, 8)}</span>
                {#if workingCopy.bookmark}
                    <span class="status-sublabel">({workingCopy.bookmark})</span>
                {/if}
            </div>
        {/if}

        {#if progress.active}
            <div
                class="status-item progress-item"
                data-testid="status-progress"
                title={progress.title || 'In progress...'}
            >
                <i class="codicon codicon-sync codicon-modifier-spin" aria-hidden="true"></i>
                {#if progress.title}
                    <span class="status-label">{progress.title}</span>
                {/if}
            </div>
        {:else if statusMessage}
            <div
                class="status-item message-item"
                data-testid="status-message"
                title={statusMessage.text}
            >
                <i class="codicon codicon-info" aria-hidden="true"></i>
                <span class="status-label">{statusMessage.text}</span>
            </div>
        {/if}
    </div>

    <div class="status-section status-right">
        <div
            class="status-item connection-item"
            data-testid="status-connection"
            data-status={connection}
            title={`Daemon: ${connection}`}
        >
            <i class="codicon codicon-radio-tower" aria-hidden="true"></i>
            <span class="status-label">
                {connection === 'connected' ? 'Host Connected' : connection === 'connecting' ? 'Connecting...' : 'Disconnected'}
            </span>
        </div>

        {#if notificationService}
            <button
                type="button"
                class="status-item status-btn bell-item"
                data-testid="status-notifications-btn"
                title={notificationCount > 0 ? `${notificationCount} active notification(s)` : 'Notifications'}
                onclick={() => {
                    if (notificationCount > 0) {
                        notificationService?.clearAll();
                    }
                }}
            >
                <i class="codicon codicon-bell" aria-hidden="true"></i>
                {#if notificationCount > 0}
                    <span class="notification-badge" data-testid="status-notification-badge">{notificationCount}</span>
                {/if}
            </button>
        {/if}

        {#if onOpenSettings}
            <button
                type="button"
                class="status-item status-btn settings-item"
                data-testid="status-settings-btn"
                aria-label="Settings"
                title="Settings"
                onclick={() => onOpenSettings()}
            >
                <i class="codicon codicon-gear" aria-hidden="true"></i>
            </button>
        {/if}
    </div>
</footer>

<style>
.app-status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 24px;
    width: 100%;
    background-color: var(--vscode-statusBar-background, var(--vscode-editor-background));
    color: var(--vscode-statusBar-foreground, var(--vscode-descriptionForeground));
    border-top: 1px solid var(--vscode-statusBar-border, var(--vscode-widget-border));
    font-family: var(--vscode-font-family);
    font-size: 11px;
    user-select: none;
    padding: 0 8px;
    box-sizing: border-box;
    flex-shrink: 0;
    z-index: 100;
}

.status-section {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 100%;
}

.status-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 100%;
    padding: 0 6px;
    border-radius: 3px;
    color: var(--vscode-statusBar-foreground, var(--vscode-descriptionForeground));
    font-size: 11px;
    white-space: nowrap;
}

.status-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: inherit;
}

.status-item:hover,
.status-btn:hover {
    background-color: var(--vscode-statusBarItem-hoverBackground, rgba(121, 121, 121, 0.2));
    color: var(--vscode-foreground);
}

.working-copy-item {
    font-weight: 500;
}

.status-sublabel {
    opacity: 0.75;
}

.progress-item {
    color: var(--vscode-charts-blue, #69b1ff);
}

.progress-item i {
    animation: codicon-spin 1.2s infinite linear;
}

@keyframes codicon-spin {
    100% {
        transform: rotate(360deg);
    }
}

.message-item {
    color: var(--vscode-foreground);
}

.connection-item[data-status="connected"] i {
    color: var(--vscode-charts-green, #60d199);
}

.connection-item[data-status="disconnected"] i {
    color: var(--vscode-charts-red, #ff6762);
}

.connection-item[data-status="connecting"] i {
    color: var(--vscode-charts-yellow, #ffd452);
}

.notification-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background-color: var(--vscode-badge-background, var(--vscode-button-background));
    color: var(--vscode-badge-foreground, var(--vscode-button-foreground));
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
}

.status-btn:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
}
</style>
