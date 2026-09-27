<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { TabEntry, TabReorderPosition } from './tab-types';

interface Props {
    tabs: TabEntry[];
    activeTabId?: string;
    onSelectTab: (tabId: string) => void;
    onCloseTab: (tabId: string) => void;
    onPinTab: (tabId: string) => void;
    onReorderTabs: (sourceTabId: string, targetTabId: string, position: TabReorderPosition) => void;
}

let { tabs, activeTabId, onSelectTab, onCloseTab, onPinTab, onReorderTabs }: Props = $props();

let draggedTabId = $state<string | null>(null);
let dropTarget = $state<{ tabId: string; position: TabReorderPosition } | null>(null);

function handleDragStart(e: DragEvent, tabId: string): void {
    if (!e.dataTransfer) {
        return;
    }
    draggedTabId = tabId;
    e.dataTransfer.setData('text/plain', tabId);
    e.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(e: DragEvent, tabId: string): void {
    if (!draggedTabId || draggedTabId === tabId || !e.dataTransfer) {
        return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const isBefore = e.clientX - rect.left < rect.width / 2;
    dropTarget = { tabId, position: isBefore ? 'before' : 'after' };
}

function handleDragLeave(e: DragEvent, tabId: string): void {
    const relatedTarget = e.relatedTarget as Node | null;
    const currentTarget = e.currentTarget as Node | null;
    if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) {
        return;
    }
    if (dropTarget?.tabId === tabId) {
        dropTarget = null;
    }
}

function handleDrop(e: DragEvent, targetTabId: string): void {
    e.preventDefault();
    const sourceId = draggedTabId || e.dataTransfer?.getData('text/plain');
    const position = dropTarget?.position ?? 'before';
    if (sourceId && sourceId !== targetTabId) {
        onReorderTabs(sourceId, targetTabId, position);
    }
    draggedTabId = null;
    dropTarget = null;
}

function handleDragEnd(): void {
    draggedTabId = null;
    dropTarget = null;
}

function handleKeyDown(e: KeyboardEvent, tabIndex: number): void {
    if (tabs.length === 0) {
        return;
    }

    if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        if (tabIndex > 0) {
            onReorderTabs(tabs[tabIndex].id, tabs[tabIndex - 1].id, 'before');
        }
        return;
    }

    if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        if (tabIndex < tabs.length - 1) {
            onReorderTabs(tabs[tabIndex].id, tabs[tabIndex + 1].id, 'after');
        }
        return;
    }

    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const prevIndex = (tabIndex - 1 + tabs.length) % tabs.length;
        onSelectTab(tabs[prevIndex].id);
        return;
    }

    if (e.key === 'ArrowRight') {
        e.preventDefault();
        const nextIndex = (tabIndex + 1) % tabs.length;
        onSelectTab(tabs[nextIndex].id);
        return;
    }

    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelectTab(tabs[tabIndex].id);
        return;
    }

    if (e.key === 'Delete') {
        e.preventDefault();
        onCloseTab(tabs[tabIndex].id);
    }
}
</script>

<div
    class="tab-bar-container"
    data-testid="tab-bar-container"
    role="tablist"
    aria-label="Open editors"
>
    {#each tabs as tab, index (tab.id)}
        {@const isActive = tab.id === activeTabId}
        {@const isDropBefore = dropTarget?.tabId === tab.id && dropTarget?.position === 'before'}
        {@const isDropAfter = dropTarget?.tabId === tab.id && dropTarget?.position === 'after'}
        {@const resourceUri = tab.view.type === 'diff'
            ? (tab.view.rightUri ?? tab.view.leftUri)
            : tab.view.type === 'file'
              ? tab.view.uri
              : undefined}
        {@const resourceScheme = resourceUri?.scheme}
        {@const resourceFilename = tab.title.replace(/\s*\([^)]*\)$/, '').trim()}
        <div
            class="tab"
            class:active={isActive}
            class:preview={tab.preview}
            class:dirty={tab.isDirty}
            class:dragging={draggedTabId === tab.id}
            class:drop-before={isDropBefore}
            class:drop-after={isDropAfter}
            data-testid={`tab-${tab.id}`}
            data-tab-id={tab.id}
            data-vscode-context={JSON.stringify({
                menuId: 'editor/title/context',
                resourceScheme,
                resourceFilename,
                resourceUri: resourceUri
                    ? {
                          scheme: resourceUri.scheme,
                          path: resourceUri.path,
                          fsPath: resourceUri.fsPath,
                          authority: resourceUri.authority,
                          query: resourceUri.query,
                          fragment: resourceUri.fragment,
                      }
                    : undefined,
                tabId: tab.id,
                preventDefaultContextMenuItems: true,
            })}
            role="tab"
            aria-selected={isActive}
            tabindex={isActive ? 0 : -1}
            title={tab.tooltip || tab.title}
            draggable="true"
            onclick={() => onSelectTab(tab.id)}
            ondblclick={() => onPinTab(tab.id)}
            onauxclick={(e) => {
                if (e.button === 1) {
                    e.preventDefault();
                    onCloseTab(tab.id);
                }
            }}
            onmousedown={(e) => {
                if (e.button === 1) {
                    e.preventDefault();
                }
            }}
            ondragstart={(e) => handleDragStart(e, tab.id)}
            ondragover={(e) => handleDragOver(e, tab.id)}
            ondragleave={(e) => handleDragLeave(e, tab.id)}
            ondrop={(e) => handleDrop(e, tab.id)}
            ondragend={handleDragEnd}
            onkeydown={(e) => handleKeyDown(e, index)}
        >
            {#if tab.iconClass}
                <i class={`tab-icon ${tab.iconClass}`} aria-hidden="true"></i>
            {/if}

            <span class="tab-label" data-testid={`tab-label-${tab.id}`}>
                {tab.title}
            </span>

            <button
                type="button"
                class="tab-close-button"
                class:dirty={tab.isDirty}
                aria-label={tab.isDirty ? `Unsaved changes in ${tab.title}` : `Close ${tab.title}`}
                data-testid={`tab-close-btn-${tab.id}`}
                onclick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                }}
            >
                {#if tab.isDirty}
                    <span class="dirty-indicator" aria-hidden="true">●</span>
                {/if}
                <i class="codicon codicon-close close-icon" aria-hidden="true"></i>
            </button>
        </div>
    {/each}
</div>

<style>
.tab-bar-container {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px;
    height: 35px;
    min-height: 35px;
    max-height: 35px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground, #171717);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #1d1d1d);
    overflow-x: auto;
    overflow-y: hidden;
    box-sizing: border-box;
    user-select: none;
}

.tab-bar-container::-webkit-scrollbar {
    height: 3px;
}

.tab-bar-container::-webkit-scrollbar-thumb {
    background-color: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
    border-radius: 2px;
}

.tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 27px;
    padding: 0 8px 0 10px;
    cursor: pointer;
    border: 1px solid transparent;
    border-radius: 6px;
    background-color: transparent;
    color: var(--vscode-tab-inactiveForeground, var(--vscode-descriptionForeground, #8a8a8a));
    font-size: var(--vscode-font-size, 13px);
    white-space: nowrap;
    outline: none;
    box-sizing: border-box;
    transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.tab:hover:not(.active) {
    background-color: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
    color: var(--vscode-tab-hoverForeground, var(--vscode-foreground, #d4d4d4));
}

.tab.active {
    background-color: var(--vscode-input-background, #262626);
    color: var(--vscode-tab-activeForeground, var(--vscode-foreground, #ffffff));
    border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, #2c2c2c));
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
}

.tab.preview .tab-label {
    font-style: italic;
    opacity: 0.88;
}

.tab.dragging {
    opacity: 0.45;
}

.tab.drop-before::before {
    content: '';
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: -3px;
    width: 2px;
    border-radius: 2px;
    background-color: var(--vscode-tab-dragAndDropBorder, var(--vscode-focusBorder, #69b1ff));
    z-index: 10;
    pointer-events: none;
}

.tab.drop-after::after {
    content: '';
    position: absolute;
    top: 3px;
    bottom: 3px;
    right: -3px;
    width: 2px;
    border-radius: 2px;
    background-color: var(--vscode-tab-dragAndDropBorder, var(--vscode-focusBorder, #69b1ff));
    z-index: 10;
    pointer-events: none;
}

.tab-icon {
    font-size: 14px;
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--vscode-icon-foreground, #8a8a8a);
    transition: color 0.15s ease;
}

.tab.active .tab-icon {
    color: var(--vscode-foreground, #d4d4d4);
}

.tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 400;
}

.tab.active .tab-label {
    font-weight: 500;
}

.tab-close-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-left: 2px;
    padding: 0;
    border: none;
    background: transparent;
    border-radius: 4px;
    cursor: pointer;
    color: inherit;
    outline: none;
    transition: background-color 0.12s ease;
}

.tab-close-button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
}

.dirty-indicator {
    font-size: 13px;
    line-height: 1;
    color: var(--vscode-editorOverviewRuler-modifiedForeground, #69b1ff);
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.close-icon {
    display: none;
    font-size: 12px;
}

/* On hover or active tabs without unsaved changes, show close icon */
.tab.active:not(.dirty) .close-icon,
.tab:hover:not(.dirty) .close-icon {
    display: inline-flex;
}

/* On dirty tab hover, swap dirty dot for close icon */
.tab-close-button.dirty:hover .dirty-indicator {
    display: none;
}

.tab-close-button.dirty:hover .close-icon {
    display: inline-flex;
}
</style>
