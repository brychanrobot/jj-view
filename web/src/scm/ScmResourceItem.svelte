<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { JjResourceState } from '../../../src/core/scm-resource-state';
import type { IContextKeyService } from '../menu/context-key-service';
import type { MenuRegistry } from '../menu/menu-registry';
import type { ResolvedMenuItem } from '../menu/menu-types';
import FileIcon from './FileIcon.svelte';

interface Props {
    resourceState: JjResourceState;
    workspaceRoot?: string;
    context: IContextKeyService;
    menuRegistry: MenuRegistry;
    onOpen: (state: JjResourceState, options?: { preview?: boolean }) => void;
    onAction: (command: string, state: JjResourceState) => void;
    onContextMenu?: (event: MouseEvent, state: JjResourceState) => void;
}

let { resourceState, workspaceRoot, context, menuRegistry, onOpen, onAction, onContextMenu }: Props = $props();

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

const displayPath = $derived.by(() => {
    if (resourceState.relativePath) {
        return resourceState.relativePath;
    }
    const fullPath = resourceState.resourceUri.path || '';
    if (workspaceRoot && fullPath.startsWith(workspaceRoot)) {
        return fullPath.slice(workspaceRoot.length).replace(/^[/\\]+/, '');
    }
    return fullPath;
});
const segments = $derived(displayPath.split(/[/\\]/));
const fileName = $derived(segments[segments.length - 1] || displayPath);
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

const vscodeContext = $derived(
    JSON.stringify({
        menuId: 'scm/resourceState/context',
        scmResourceState: resourceState.contextValue || '',
        resourceFilename: fileName,
        resourceScheme: resourceState.resourceUri.scheme,
        preventDefaultContextMenuItems: true,
        resourceState,
    }),
);

function handleClick(): void {
    onOpen(resourceState, { preview: true });
}

function handleDblClick(): void {
    onOpen(resourceState, { preview: false });
}
</script>

<div
    class="scm-resource-item"
    data-testid="scm-resource-item"
    data-path={displayPath}
    data-vscode-context={vscodeContext}
    role="treeitem"
    aria-selected="false"
    tabindex="0"
    onclick={handleClick}
    ondblclick={handleDblClick}
    onkeydown={(e) => {
        if (e.key === 'Enter') {
            onOpen(resourceState, { preview: false });
        } else if (e.key === ' ') {
            e.preventDefault();
            onOpen(resourceState, { preview: true });
        }
    }}
    oncontextmenu={(e) => onContextMenu?.(e, resourceState)}
>
    <div class="resource-label-container">
        <FileIcon filename={fileName} />
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
    height: 22px;
    min-height: 22px;
    max-height: 22px;
    padding: 0 12px 0 20px;
    margin: 0;
    border-radius: 0;
    cursor: pointer;
    user-select: none;
    font-family: var(--vscode-font-family, system-ui, Ubuntu, "Droid Sans", sans-serif);
    font-size: var(--vscode-font-size, 13px);
    line-height: 22px;
    color: var(--vscode-foreground, #d4d4d4);
    transition: background-color 0.1s ease;
    box-sizing: border-box;
    overflow: hidden;
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
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    line-height: 22px;
}

.file-name {
    font-weight: normal;
    color: var(--vscode-foreground, #d4d4d4);
    font-size: var(--vscode-font-size, 13px);
    flex-shrink: 0;
    line-height: 22px;
}

.file-name.deleted {
    text-decoration: line-through;
    opacity: 0.75;
}

.dir-name {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 22px;
    opacity: 0.85;
}

.resource-actions-container {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    height: 100%;
}

.hover-actions {
    display: none;
    align-items: center;
    gap: 2px;
    height: 100%;
}

.scm-resource-item:hover .hover-actions,
.scm-resource-item:focus-within .hover-actions {
    display: flex;
}

.item-action-button {
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
    padding: 0 5px;
    border-radius: 8px;
    height: 16px;
    line-height: 16px;
    min-width: 14px;
    user-select: none;
    box-sizing: border-box;
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
