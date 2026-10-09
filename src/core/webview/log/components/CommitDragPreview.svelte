<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { getChangeIdDisplayLength, shortenChangeId } from '../../../../utils/jj-utils';
import {
    type DragActionModifier,
    DUPLICATE_MODIFIER,
    INSERT_AFTER_BRANCH_MODIFIER,
    INSERT_AFTER_REVISION_MODIFIER,
    INSERT_BEFORE_BRANCH_MODIFIER,
    INSERT_BEFORE_REVISION_MODIFIER,
    MERGE_MODIFIER,
    REBASE_BRANCH_MODIFIER,
    REBASE_REVISION_MODIFIER,
    SQUASH_INTO_MODIFIER,
    SQUASH_ONTO_MODIFIER,
} from '../utils/drag-modifiers';
import type { CommitDragData } from './CommitDragPreview';

interface Props {
    commit: CommitDragData;
    activeModifier?: DragActionModifier;
    minChangeIdLength: number;
}

let { commit, activeModifier: activeModifierProp, minChangeIdLength }: Props = $props();

const MODIFIER_ROW1 = [
    REBASE_REVISION_MODIFIER,
    INSERT_AFTER_REVISION_MODIFIER,
    INSERT_AFTER_BRANCH_MODIFIER,
    INSERT_BEFORE_REVISION_MODIFIER,
    INSERT_BEFORE_BRANCH_MODIFIER,
];
const MODIFIER_ROW2 = [SQUASH_INTO_MODIFIER, SQUASH_ONTO_MODIFIER, DUPLICATE_MODIFIER, MERGE_MODIFIER];
const MODIFIER_ROWS = [MODIFIER_ROW1, MODIFIER_ROW2];

const activeModifier = $derived(activeModifierProp || REBASE_BRANCH_MODIFIER);
const activeColor = $derived(activeModifier.accentColor);

const fullId = $derived(commit.changeId || '');
const idDisplayLength = $derived(getChangeIdDisplayLength(commit.change_id_shortest, minChangeIdLength));
const shortId = $derived(commit.change_id_shortest || shortenChangeId(fullId, idDisplayLength));
const remainderId = $derived(fullId.substring(shortId.length, idDisplayLength));

const descendantCount = $derived(commit.descendantCount ?? 0);
const includesDescendants = $derived(activeModifier.includesDescendants ?? false);
const showDescendantsBadge = $derived(includesDescendants && descendantCount > 0);
</script>

<div class="card">
    <div class="content-row">
        <!-- Left Handle -->
        <div class="left-handle" style:background-color={activeColor}></div>

        <!-- Content Area -->
        <div class="content-area">
            <!-- Row 1: Description -->
            <div class="description-row">{commit.description || '(no description)'}</div>

            <!-- Row 2: ID + Status -->
            <div class="id-status-row">
                <span class="id-span">
                    <span class="short-id">{shortId}</span>
                    <span class="remainder-id">{remainderId}</span>
                </span>
                <span class="dot-separator">•</span>
                <span class="action-label" style:color={activeColor}>{activeModifier.label}</span>
                {#if showDescendantsBadge}
                    <span class="descendants-pill">+{descendantCount} {descendantCount === 1 ? 'child' : 'children'}</span>
                {/if}
            </div>
        </div>
    </div>

    <!-- Bottom Shortcut Hint Footer -->
    <div class="footer">
        <div class="footer-description-row">
            <span>
                <strong style:color={activeColor}>{activeModifier.shortcutHint}</strong>: {activeModifier.description}
            </span>
        </div>
        <div class="badge-matrix">
            {#each MODIFIER_ROWS as row}
                <div class="badge-row">
                    {#each row as modifier (modifier.id)}
                        {@const isCurrent = activeModifier.id === modifier.id}
                        <span
                            class="badge-container"
                            class:current={isCurrent}
                            style:border={isCurrent ? `1px solid ${activeColor}` : '1px solid transparent'}
                        >
                            <kbd
                                class="badge-kbd"
                                style:color={isCurrent ? activeColor : 'var(--vscode-keybindingLabel-foreground, inherit)'}
                                style:font-weight={isCurrent ? 'bold' : 'normal'}
                            >
                                {modifier.shortcutHint}
                            </kbd>
                            <span
                                class="badge-label"
                                style:color={isCurrent ? activeColor : 'var(--vscode-descriptionForeground)'}
                                style:font-weight={isCurrent ? 'bold' : 'normal'}
                            >
                                {modifier.shortLabel || modifier.label}
                            </span>
                        </span>
                    {/each}
                </div>
            {/each}
        </div>
    </div>
</div>

<style>
    .card {
        display: flex;
        flex-direction: column;
        background-color: var(--vscode-editor-background);
        border: 1px solid var(--vscode-focusBorder);
        border-radius: 6px;
        box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3));
        min-width: 260px;
        width: max-content;
        max-width: min(420px, calc(100vw - 16px));
        overflow: hidden;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
        transition: none;
        will-change: transform;
        pointer-events: none;
    }

    .content-row {
        display: flex;
        flex-direction: row;
        height: 48px;
    }

    .left-handle {
        width: 6px;
        height: 100%;
        flex-shrink: 0;
    }

    .content-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 0 10px;
        min-width: 0;
    }

    .description-row {
        font-weight: bold;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 2px;
        color: var(--vscode-foreground);
    }

    .id-status-row {
        display: flex;
        align-items: center;
        font-size: 0.9em;
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
        overflow: hidden;
    }

    .id-span {
        font-family: var(--vscode-editor-font-family);
        margin-right: 8px;
        display: flex;
    }

    .short-id {
        color: var(--vscode-gitDecoration-addedResourceForeground);
        font-weight: bold;
    }

    .remainder-id {
        opacity: 0.7;
    }

    .dot-separator {
        margin-right: 8px;
        opacity: 0.5;
    }

    .action-label {
        font-weight: 600;
        display: flex;
        align-items: center;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .descendants-pill {
        display: inline-flex;
        align-items: center;
        margin-left: 6px;
        padding: 0 5px;
        height: 16px;
        border-radius: 4px;
        font-size: 0.85em;
        font-weight: 600;
        background-color: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        white-space: nowrap;
        flex-shrink: 0;
    }

    .footer {
        background-color: var(--vscode-editor-lineHighlightBackground);
        border-top: 1px solid var(--vscode-widget-border);
        padding: 6px 8px;
        font-size: 0.75em;
        color: var(--vscode-descriptionForeground);
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-family: var(--vscode-editor-font-family);
    }

    .footer-description-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .badge-matrix {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.95em;
        background-color: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
        border: 1px solid var(--vscode-widget-border);
        border-radius: 4px;
        padding: 4px 6px;
        margin-top: 2px;
        overflow: hidden;
    }

    .badge-row {
        display: flex;
        gap: 6px;
        align-items: center;
        flex-wrap: wrap;
    }

    .badge-container {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 1px 4px;
        border-radius: 3px;
        white-space: nowrap;
        background-color: transparent;
    }

    .badge-container.current {
        background-color: var(--vscode-keybindingTable-headerBackground, var(--vscode-list-activeSelectionBackground));
    }

    .badge-kbd {
        font-size: 0.85em;
        font-family: var(--vscode-editor-font-family);
        padding: 0 3px;
        border-radius: 3px;
        background-color: var(--vscode-keybindingLabel-background);
        border: 1px solid var(--vscode-keybindingLabel-border, var(--vscode-widget-border));
        white-space: nowrap;
    }

    .badge-label {
        white-space: nowrap;
    }
</style>
