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
        </div>
    </div>
</header>

<style>
.scm-header {
    padding: 6px 12px;
    background-color: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background, #1e1e1e));
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128, 128, 128, 0.2));
    user-select: none;
}

.scm-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 24px;
}

.scm-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-sideBarTitle-foreground, #bbbbbb);
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
    color: var(--vscode-icon-foreground, #c5c5c5);
    border: none;
    border-radius: 4px;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
}

.toolbar-button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
    color: var(--vscode-foreground, #ffffff);
}

.toolbar-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
}
</style>
