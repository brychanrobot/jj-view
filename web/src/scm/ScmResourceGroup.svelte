<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { JjResourceState } from '../../../src/core/scm-resource-state';
import type { IContextKeyService } from '../menu/context-key-service';
import type { MenuRegistry } from '../menu/menu-registry';
import type { ResolvedMenuItem } from '../menu/menu-types';
import ScmResourceItem from './ScmResourceItem.svelte';

interface Props {
    id: string;
    label: string;
    contextValue?: string;
    items: JjResourceState[];
    expanded?: boolean;
    rootContext: IContextKeyService;
    menuRegistry: MenuRegistry;
    onGroupAction: (command: string, groupId: string) => void;
    onOpenResource: (state: JjResourceState) => void;
    onResourceAction: (command: string, state: JjResourceState) => void;
    onGroupContextMenu: (event: MouseEvent, groupId: string) => void;
    onResourceContextMenu: (event: MouseEvent, state: JjResourceState) => void;
}

let {
    id,
    label,
    contextValue = '',
    items,
    expanded = true,
    rootContext,
    menuRegistry,
    onGroupAction,
    onOpenResource,
    onResourceAction,
    onGroupContextMenu,
    onResourceContextMenu,
}: Props = $props();

// svelte-ignore state_referenced_locally
let isExpanded = $state(expanded);
const groupContext = $derived(
    rootContext.createScoped({
        scmResourceGroupState: contextValue,
        scmResourceGroupId: id,
    }),
);

let version = $state(0);

$effect(() => {
    const disposable = groupContext.onDidChangeContext(() => {
        version++;
    });
    return () => {
        disposable.dispose();
    };
});

const groupActions: ResolvedMenuItem[] = $derived.by(() => {
    if (version < 0) {
        return [];
    }
    return menuRegistry.getInlineActions('scm/resourceGroup/context', groupContext);
});

function toggleExpanded(): void {
    isExpanded = !isExpanded;
}
</script>

<div class="scm-resource-group" data-testid={`scm-group-${id}`}>
    <div
        class="group-header"
        data-testid={`scm-group-header-${id}`}
        role="button"
        tabindex="0"
        onclick={toggleExpanded}
        onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                toggleExpanded();
            }
        }}
        oncontextmenu={(e) => onGroupContextMenu(e, id)}
    >
        <div class="group-title-row">
            <span class="chevron-icon">
                <i class={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} aria-hidden="true"></i>
            </span>
            <span class="group-label" title={label}>{label}</span>
        </div>

        <div class="group-actions-row">
            <div class="group-hover-actions" role="toolbar" aria-label="Group Actions">
                {#each groupActions as action (action.command)}
                    <button
                        type="button"
                        class="icon-button group-action-button"
                        data-testid={`scm-group-action-${action.command}`}
                        title={action.title}
                        aria-label={action.title}
                        onclick={(e) => {
                            e.stopPropagation();
                            onGroupAction(action.command, id);
                        }}
                    >
                        {#if action.iconClass}
                            <i class={action.iconClass} aria-hidden="true"></i>
                        {:else}
                            <span>{action.title}</span>
                        {/if}
                    </button>
                {/each}
            </div>

            <span class="count-badge" title={`${items.length} files`}>
                {items.length}
            </span>
        </div>
    </div>

    {#if isExpanded}
        <div class="group-items-container" role="group">
            {#each items as item (item.resourceUri.toString())}
                {@const itemContext = groupContext.createScoped({
                    scmResourceState: item.contextValue || '',
                    resourceFilename: item.resourceUri.path.split('/').pop() || '',
                    resourceScheme: item.resourceUri.scheme,
                })}
                <ScmResourceItem
                    resourceState={item}
                    context={itemContext}
                    {menuRegistry}
                    onOpen={onOpenResource}
                    onAction={onResourceAction}
                    onContextMenu={onResourceContextMenu}
                />
            {/each}
        </div>
    {/if}
</div>

<style>
.scm-resource-group {
    display: flex;
    flex-direction: column;
}

.group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 26px;
    padding: 0 12px 0 8px;
    margin: 2px 4px;
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    background-color: transparent;
    transition: background-color 0.12s;
}

.group-header:hover {
    background-color: var(--vscode-list-hoverBackground, rgba(31, 62, 94, 0.35));
}

.group-header:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #69b1ff);
    outline-offset: -1px;
}

.group-title-row {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}

.chevron-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    font-size: 14px;
    color: var(--vscode-icon-foreground, #8a8a8a);
}

.group-label {
    overflow: hidden;
    text-overflow: ellipsis;
}

.group-actions-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

.group-hover-actions {
    display: none;
    align-items: center;
    gap: 2px;
}

.group-header:hover .group-hover-actions,
.group-header:focus-within .group-hover-actions {
    display: flex;
}

.group-action-button {
    background: transparent;
    color: var(--vscode-icon-foreground, #8a8a8a);
    border: none;
    border-radius: 4px;
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    transition: background-color 0.15s, color 0.15s;
}

.group-action-button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(31, 62, 94, 0.45));
    color: var(--vscode-foreground);
}

.count-badge {
    background-color: color-mix(in srgb, var(--vscode-editor-foreground), transparent 90%);
    color: var(--vscode-descriptionForeground, #8a8a8a);
    border-radius: 10px;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 700;
    min-width: 14px;
    text-align: center;
    line-height: 14px;
    user-select: none;
}

.group-items-container {
    display: flex;
    flex-direction: column;
}
</style>
