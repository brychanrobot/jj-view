<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { onMount } from 'svelte';
import type { ResolvedMenuItem, ResolvedMenuItemGroup } from '../menu/menu-types';

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

    return () => {
        window.removeEventListener('pointerdown', handleDismiss, { capture: true });
        window.removeEventListener('contextmenu', handleDismiss, { capture: true });
        window.removeEventListener('keydown', handleKeyDown);
    };
});
</script>

<div
    bind:this={menuEl}
    class="scm-context-menu"
    data-testid="scm-context-menu"
    role="menu"
    tabindex="-1"
    style={`left: ${posX}px; top: ${posY}px;`}
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
.scm-context-menu {
    position: fixed;
    z-index: 10000;
    min-width: 180px;
    max-width: 320px;
    background-color: var(--vscode-menu-background, #1d1d1d);
    color: var(--vscode-menu-foreground, #d4d4d4);
    border: 1px solid var(--vscode-menu-border, #262626);
    border-radius: 6px;
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.4);
    padding: 4px 0;
    user-select: none;
}

.menu-separator {
    height: 1px;
    background-color: var(--vscode-menu-separatorBackground, #262626);
    margin: 4px 0;
}

.menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 12px;
    background: transparent;
    border: none;
    color: inherit;
    font-family: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    box-sizing: border-box;
}

.menu-item:hover,
.menu-item:focus-visible {
    background-color: var(--vscode-menu-selectionBackground, #1f3e5e99);
    color: var(--vscode-menu-selectionForeground, #d4d4d4);
    outline: none;
}

.item-icon {
    width: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.item-title {
    flex-grow: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
