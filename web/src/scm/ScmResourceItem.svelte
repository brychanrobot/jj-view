<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { JjResourceState } from '../../../src/core/scm-resource-state';
import type { IContextKeyService } from '../menu/context-key-service';
import type { MenuRegistry } from '../menu/menu-registry';
import type { ResolvedMenuItem } from '../menu/menu-types';

interface Props {
    resourceState: JjResourceState;
    context: IContextKeyService;
    menuRegistry: MenuRegistry;
    onOpen: (state: JjResourceState) => void;
    onAction: (command: string, state: JjResourceState) => void;
    onContextMenu: (event: MouseEvent, state: JjResourceState) => void;
}

let { resourceState, context, menuRegistry, onOpen, onAction, onContextMenu }: Props = $props();

let version = $state(0);

$effect(() => {
    const disposable = context.onDidChangeContext(() => {
        version++;
    });
    return () => {
        disposable.dispose();
    };
});

const inlineActions: ResolvedMenuItem[] = $derived.by(() => {
    // Register dependency on version
    if (version < 0) {
        return [];
    }
    return menuRegistry.getInlineActions('scm/resourceState/context', context);
});

const pathStr = $derived(resourceState.resourceUri.path || '');
const segments = $derived(pathStr.split('/'));
const fileName = $derived(segments[segments.length - 1] || pathStr);
const dirName = $derived(segments.slice(0, -1).filter(Boolean).join('/'));

const isDeleted = $derived(resourceState.decorations?.strikeThrough ?? false);

function getStatusBadge(): { letter: string; title: string; className: string } {
    const val = resourceState.contextValue || '';
    if (val.includes('allowOpenMergeEditor')) {
        return { letter: '!', title: 'Conflicted', className: 'status-conflicted' };
    }
    if (isDeleted || resourceState.status === 'deleted') {
        return { letter: 'D', title: 'Deleted', className: 'status-deleted' };
    }
    if (resourceState.status === 'added') {
        return { letter: 'A', title: 'Added', className: 'status-added' };
    }
    return { letter: 'M', title: 'Modified', className: 'status-modified' };
}

const statusBadge = $derived(getStatusBadge());
</script>

<div
    class="scm-resource-item"
    data-testid="scm-resource-item"
    data-path={pathStr}
    role="treeitem"
    aria-selected="false"
    tabindex="0"
    onclick={() => onOpen(resourceState)}
    onkeydown={(e) => {
        if (e.key === 'Enter') {
            onOpen(resourceState);
        }
    }}
    oncontextmenu={(e) => onContextMenu(e, resourceState)}
>
    <div class="resource-label-container">
        <span class="file-name" class:deleted={isDeleted}>{fileName}</span>
        {#if dirName}
            <span class="dir-name">{dirName}</span>
        {/if}
    </div>

    <div class="resource-actions-container">
        <div class="hover-actions" role="toolbar" aria-label="File Actions">
            {#each inlineActions as action (action.command)}
                <button
                    type="button"
                    class="icon-button item-action-button"
                    data-testid={`scm-resource-action-${action.command}`}
                    title={action.title}
                    aria-label={action.title}
                    onclick={(e) => {
                        e.stopPropagation();
                        onAction(action.command, resourceState);
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

        <span
            class={`status-badge ${statusBadge.className}`}
            title={statusBadge.title}
            aria-label={statusBadge.title}
        >
            {statusBadge.letter}
        </span>
    </div>
</div>

<style>
.scm-resource-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 26px;
    padding: 4px 12px 4px 20px;
    margin: 1px 4px;
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground, #d4d4d4);
    transition: background-color 0.12s;
    box-sizing: border-box;
}

.scm-resource-item:hover {
    background-color: var(--vscode-list-hoverBackground, rgba(31, 62, 94, 0.35));
}

.scm-resource-item:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #69b1ff);
    outline-offset: -1px;
}

.resource-label-container {
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}

.file-name {
    font-weight: 500;
    color: var(--vscode-foreground, #d4d4d4);
}

.file-name.deleted {
    text-decoration: line-through;
    opacity: 0.8;
}

.dir-name {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    margin-left: 2px;
}

.resource-actions-container {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

.hover-actions {
    display: none;
    align-items: center;
    gap: 2px;
}

.scm-resource-item:hover .hover-actions,
.scm-resource-item:focus-within .hover-actions {
    display: flex;
}

.item-action-button {
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

.item-action-button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(31, 62, 94, 0.45));
    color: var(--vscode-foreground);
}

.status-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 1px 6px;
    border-radius: 10px;
    line-height: 14px;
    min-width: 14px;
    user-select: none;
}

.status-modified {
    color: var(--vscode-gitDecoration-modifiedResourceForeground, #69b1ff);
    background: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, #69b1ff) 14%, transparent);
}

.status-added {
    color: var(--vscode-gitDecoration-addedResourceForeground, #60d199);
    background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #60d199) 14%, transparent);
}

.status-deleted {
    color: var(--vscode-gitDecoration-deletedResourceForeground, #ff6762);
    background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #ff6762) 14%, transparent);
}

.status-conflicted {
    color: var(--vscode-gitDecoration-conflictingResourceForeground, #9d6afb);
    background: color-mix(in srgb, var(--vscode-gitDecoration-conflictingResourceForeground, #9d6afb) 12%, transparent);
}
</style>
