<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { NotificationItem } from './notification-types';

interface Props {
    item: NotificationItem;
    onAction: (action: string) => void;
    onDismiss: () => void;
}

let { item, onAction, onDismiss }: Props = $props();

const role = $derived(item.severity === 'error' ? 'alert' : 'status');
const ariaLive = $derived(item.severity === 'error' ? 'assertive' : 'polite');

const iconClass = $derived.by(() => {
    switch (item.severity) {
        case 'error':
            return 'codicon codicon-error error-icon';
        case 'warning':
            return 'codicon codicon-warning warning-icon';
        default:
            return 'codicon codicon-info info-icon';
    }
});
</script>

<div
    class="notification-toast severity-{item.severity}"
    data-testid="notification-toast"
    data-severity={item.severity}
    {role}
    aria-live={ariaLive}
>
    <div class="toast-content-row">
        <div class="toast-icon-col">
            <i class={iconClass} aria-hidden="true"></i>
        </div>
        <div class="toast-message-col" data-testid="notification-message">
            {item.message}
        </div>
        <div class="toast-close-col">
            <button
                type="button"
                class="toast-close-btn"
                data-testid="notification-close-btn"
                aria-label="Close notification"
                onclick={() => onDismiss()}
            >
                <i class="codicon codicon-close" aria-hidden="true"></i>
            </button>
        </div>
    </div>

    {#if item.actions && item.actions.length > 0}
        <div class="toast-actions-row" data-testid="notification-actions">
            {#each item.actions as action (action)}
                <button
                    type="button"
                    class="toast-action-btn"
                    data-testid={`notification-action-${action}`}
                    onclick={() => onAction(action)}
                >
                    {action}
                </button>
            {/each}
        </div>
    {/if}
</div>

<style>
.notification-toast {
    display: flex;
    flex-direction: column;
    width: 380px;
    max-width: calc(100vw - 32px);
    background-color: var(--vscode-notifications-background, var(--vscode-editor-background));
    color: var(--vscode-notifications-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-notificationToast-border, var(--vscode-widget-border));
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
    padding: 10px 12px;
    gap: 8px;
    font-size: var(--vscode-font-size, 13px);
    font-family: var(--vscode-font-family);
    box-sizing: border-box;
    pointer-events: auto;
    animation: toast-enter 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes toast-enter {
    from {
        opacity: 0;
        transform: translateY(6px) scale(0.98);
    }
    to {
        opacity: 1;
        transform: translateY(0) scale(1);
    }
}

.toast-content-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
}

.toast-icon-col {
    display: flex;
    align-items: center;
    justify-content: center;
    padding-top: 1px;
    flex-shrink: 0;
}

.info-icon {
    color: var(--vscode-notificationsInfoIcon-foreground, var(--vscode-charts-blue, #69b1ff));
    font-size: 16px;
}

.warning-icon {
    color: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-charts-yellow, #ffd452));
    font-size: 16px;
}

.error-icon {
    color: var(--vscode-notificationsErrorIcon-foreground, var(--vscode-charts-red, #ff6762));
    font-size: 16px;
}

.toast-message-col {
    flex: 1;
    min-width: 0;
    line-height: 1.45;
    word-break: break-word;
    color: var(--vscode-notifications-foreground, var(--vscode-foreground));
}

.toast-close-col {
    flex-shrink: 0;
}

.toast-close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground));
    cursor: pointer;
    padding: 0;
}

.toast-close-btn:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(121, 121, 121, 0.2));
    color: var(--vscode-foreground);
}

.toast-actions-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 4px;
    border-top: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border));
}

.toast-action-btn {
    padding: 4px 10px;
    background-color: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-input-border));
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
    transition: background-color 0.1s ease;
}

.toast-action-btn:first-child {
    background-color: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 1px solid transparent;
}

.toast-action-btn:first-child:hover {
    background-color: var(--vscode-button-hoverBackground);
}

.toast-action-btn:hover:not(:first-child) {
    background-color: var(--vscode-button-secondaryHoverBackground);
}

.toast-action-btn:focus-visible,
.toast-close-btn:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
}
</style>
