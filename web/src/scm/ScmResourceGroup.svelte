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
    workspaceRoot?: string;
    revision?: string;
    changeId?: string;
    commitId?: string;
    expanded?: boolean;
    rootContext: IContextKeyService;
    menuRegistry: MenuRegistry;
    onGroupAction: (command: string, groupId: string) => void;
    onOpenResource: (state: JjResourceState, options?: { preview?: boolean }) => void;
    onResourceAction: (command: string, state: JjResourceState) => void;
    onGroupContextMenu?: (event: MouseEvent, groupId: string) => void;
    onResourceContextMenu?: (event: MouseEvent, state: JjResourceState) => void;
}

let {
    id,
    label,
    contextValue = '',
    items,
    workspaceRoot,
    revision,
    changeId,
    commitId,
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

const groupVsCodeContext = $derived(
    JSON.stringify({
        menuId: 'scm/resourceGroup/context',
        scmResourceGroupState: contextValue,
        scmResourceGroupId: id,
        preventDefaultContextMenuItems: true,
        groupId: id,
        ...(revision ? { revision } : {}),
        ...(changeId ? { changeId } : {}),
        ...(commitId ? { commitId } : {}),
    }),
);
</script>

<div class="scm-resource-group" data-testid={`scm-group-${id}`}>
    <div
        class="group-header"
        data-testid={`scm-group-header-${id}`}
        data-vscode-context={groupVsCodeContext}
        role="button"
        tabindex="0"
        onclick={toggleExpanded}
        onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                toggleExpanded();
            }
        }}
        oncontextmenu={(e) => onGroupContextMenu?.(e, id)}
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
                    {workspaceRoot}
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
    height: 22px;
    min-height: 22px;
    max-height: 22px;
    padding: 0 12px 0 8px;
    margin: 0;
    border-radius: 0;
    cursor: pointer;
    user-select: none;
    font-family: var(--vscode-font-family, system-ui, Ubuntu, "Droid Sans", sans-serif);
    font-size: var(--vscode-font-size, 13px);
    font-weight: 600;
    text-transform: none;
    letter-spacing: normal;
    color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground, #d4d4d4));
    background-color: transparent;
    transition: background-color 0.1s ease;
    box-sizing: border-box;
    overflow: hidden;
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
    min-width: 0;
}

.chevron-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    font-size: 16px;
    color: var(--vscode-icon-foreground, #c5c5c5);
    flex-shrink: 0;
}

.group-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.group-actions-row {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    height: 100%;
}

.group-hover-actions {
    display: none;
    align-items: center;
    gap: 2px;
    height: 100%;
}

.group-header:hover .group-hover-actions,
.group-header:focus-within .group-hover-actions {
    display: flex;
}

.group-action-button {
    background: transparent;
    color: var(--vscode-icon-foreground, #8a8a8a);
    border: none;
    border-radius: 3px;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    font-size: 14px;
    line-height: 1;
    transition: background-color 0.15s, color 0.15s;
    box-sizing: border-box;
}

.group-action-button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(31, 62, 94, 0.45));
    color: var(--vscode-foreground);
}

.count-badge {
    background-color: var(--vscode-badge-background, #007acc);
    color: var(--vscode-badge-foreground, #ffffff);
    border-radius: 11px;
    padding: 0 6px;
    font-size: 11px;
    font-weight: 600;
    min-width: 18px;
    height: 18px;
    line-height: 18px;
    text-align: center;
    user-select: none;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.group-items-container {
    display: flex;
    flex-direction: column;
}
</style>
