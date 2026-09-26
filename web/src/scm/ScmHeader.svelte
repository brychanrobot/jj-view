<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { IContextKeyService } from '../menu/context-key-service';
import type { MenuRegistry } from '../menu/menu-registry';
import type { ResolvedMenuItem } from '../menu/menu-types';

interface Props {
    title?: string;
    menuRegistry: MenuRegistry;
    context: IContextKeyService;
    onAction: (command: string) => void;
}

let { title = 'SOURCE CONTROL', menuRegistry, context, onAction }: Props = $props();

let version = $state(0);

// Subscribe to context changes
$effect(() => {
    const disposable = context.onDidChangeContext(() => {
        version++;
    });
    return () => {
        disposable.dispose();
    };
});

const actions: ResolvedMenuItem[] = $derived.by(() => {
    if (version < 0) {
        return [];
    }
    return menuRegistry.getInlineActions('scm/title', context);
});
</script>

<header class="scm-header" data-testid="scm-header">
    <div class="scm-title-row">
        <span class="scm-title">{title}</span>
        <div class="scm-toolbar" role="toolbar" aria-label="Source Control Actions">
            {#each actions as action (action.command)}
                <button
                    type="button"
                    class="icon-button toolbar-button"
                    data-testid={`scm-title-action-${action.command}`}
                    title={action.title}
                    aria-label={action.title}
                    onclick={() => onAction(action.command)}
                >
                    {#if action.iconClass}
                        <i class={action.iconClass} aria-hidden="true"></i>
                    {:else}
                        <span>{action.title}</span>
                    {/if}
                </button>
            {/each}
            <button
                type="button"
                class="icon-button toolbar-button"
                data-testid="scm-settings-button"
                title="Settings (Ctrl+,)"
                aria-label="Settings"
                onclick={() => onAction('jj-view.openSettings')}
            >
                <i class="codicon codicon-settings-gear" aria-hidden="true"></i>
            </button>
        </div>
    </div>
</header>

<style>
.scm-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 35px;
    padding: 0 12px 0 16px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground, #171717);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #1d1d1d);
    user-select: none;
    box-sizing: border-box;
}

.scm-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
}

.scm-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.scm-toolbar {
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

.toolbar-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #69b1ff);
}
</style>
