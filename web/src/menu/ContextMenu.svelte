<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { onMount } from 'svelte';
import type { ResolvedMenuItemGroup } from './menu-types';

interface Props {
    x: number;
    y: number;
    groups: readonly ResolvedMenuItemGroup[];
    onSelect: (command: string) => void;
    onClose: () => void;
}

let { x, y, groups, onSelect, onClose }: Props = $props();

let menuEl: HTMLDivElement | null = $state(null);
// svelte-ignore state_referenced_locally
let posX = $state(x);
// svelte-ignore state_referenced_locally
let posY = $state(y);

$effect(() => {
    posX = x;
    posY = y;
    if (menuEl && typeof window !== 'undefined') {
        const rect = menuEl.getBoundingClientRect();
        const maxX = window.innerWidth - rect.width - 8;
        const maxY = window.innerHeight - rect.height - 8;
        posX = Math.max(8, Math.min(x, maxX));
        posY = Math.max(8, Math.min(y, maxY));
    }
});

function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!menuEl) {
            return;
        }
        const buttons = Array.from(menuEl.querySelectorAll<HTMLButtonElement>('button.menu-item'));
        if (buttons.length === 0) {
            return;
        }
        const activeIdx = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown') {
            const nextIdx = activeIdx < buttons.length - 1 ? activeIdx + 1 : 0;
            buttons[nextIdx].focus();
        } else {
            const prevIdx = activeIdx > 0 ? activeIdx - 1 : buttons.length - 1;
            buttons[prevIdx].focus();
        }
    }
}

function handleDismiss(e: Event): void {
    if (menuEl && !menuEl.contains(e.target as Node)) {
        onClose();
    }
}

onMount(() => {
    window.addEventListener('pointerdown', handleDismiss, { capture: true });
    window.addEventListener('contextmenu', handleDismiss, { capture: true });
    window.addEventListener('keydown', handleKeyDown);

    // Auto-focus the menu container
    menuEl?.focus();

    return () => {
        window.removeEventListener('pointerdown', handleDismiss, { capture: true });
        window.removeEventListener('contextmenu', handleDismiss, { capture: true });
        window.removeEventListener('keydown', handleKeyDown);
    };
});
</script>

<div
    bind:this={menuEl}
    class="context-menu"
    data-testid="context-menu"
    role="menu"
    tabindex="-1"
    style={`left: ${posX}px; top: ${posY}px;`}
    oncontextmenu={(e) => e.preventDefault()}
>
    {#each groups as group, groupIdx (group.groupName)}
        {#if groupIdx > 0}
            <div class="menu-separator" role="separator"></div>
        {/if}
        {#each group.items as item (item.command)}
            <button
                type="button"
                class="menu-item"
                role="menuitem"
                data-testid={`menu-item-${item.command}`}
                onclick={() => {
                    onSelect(item.command);
                    onClose();
                }}
            >
                <span class="item-icon">
                    {#if item.iconClass}
                        <i class={item.iconClass} aria-hidden="true"></i>
                    {/if}
                </span>
                <span class="item-title">{item.title}</span>
            </button>
        {/each}
    {/each}
</div>

<style>
.context-menu {
    position: fixed;
    z-index: 2500;
    min-width: 180px;
    max-width: 320px;
    background-color: var(--vscode-menu-background, var(--vscode-editor-background, #171717));
    color: var(--vscode-menu-foreground, var(--vscode-foreground, #d4d4d4));
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, #333333));
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
    padding: 4px 0;
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    user-select: none;
    outline: none;
}

.menu-separator {
    height: 1px;
    background-color: var(--vscode-menu-separatorBackground, var(--vscode-widget-border, #333333));
    margin: 4px 0;
}

.menu-item {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 6px 12px;
    border: none;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    text-align: left;
    cursor: pointer;
    outline: none;
    gap: 8px;
    box-sizing: border-box;
}

.menu-item:hover,
.menu-item:focus {
    background-color: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground, #2a2d2e));
    color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground, #ffffff));
}

.item-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    font-size: 14px;
}

.item-title {
    flex-grow: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
