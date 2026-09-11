<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { ActionPayload, CommitAction } from '../../../host/ipc/log-view-schemas';
import type { JjBookmark, JjLogEntry } from '../../../jj-types';
import { BookmarkPill, IconButton, TagPill, WorkspacePill } from '../../common/components';
import type { DragManager } from '../drag-manager.svelte';
import { COMMIT_ROW_PADDING_LEFT } from '../layout-constants';
import { computeCommitActions } from '../utils/commit-utils';
import DraggableBookmark from './DraggableBookmark.svelte';

interface Props {
    commit: JjLogEntry;
    onClick: (modifiers: { multiSelect: boolean }) => void;
    onAction: (action: string, payload: ActionPayload) => void;
    isSelected?: boolean;
    selectionCount: number;
    hasImmutableSelection: boolean;
    idDisplayLength: number;
    hiddenActions?: Set<CommitAction>;
    dragManager: DragManager;
}

let {
    commit,
    onClick,
    onAction,
    isSelected = false,
    selectionCount,
    hasImmutableSelection,
    idDisplayLength,
    hiddenActions = new Set(),
    dragManager,
}: Props = $props();

let isHovered = $state(false);

const isImmutable = $derived(commit.is_immutable || false);
const isCurrentWorkingCopy = $derived(commit.is_current_working_copy);
const isConflict = $derived(commit.conflict);
const isEmpty = $derived(commit.is_empty);
const codeForgeChange = $derived(commit.codeForgeChange);

const actionsInfo = $derived(
    computeCommitActions(commit, hiddenActions, isSelected, selectionCount, hasImmutableSelection),
);
const visibleActions = $derived(actionsInfo.visibleActions);
const vscodeContext = $derived(actionsInfo.vscodeContext);

const isOver = $derived(dragManager.activeDropTarget?.changeId === commit.change_id);
const isDraggingThis = $derived(
    dragManager.activeDragItem?.type === 'commit' && dragManager.activeDragItem.changeId === commit.change_id,
);

// Background color computation
const backgroundColor = $derived.by(() => {
    if (isSelected) {
        if (isConflict) {
            return 'color-mix(in srgb, var(--vscode-list-inactiveSelectionBackground), var(--vscode-charts-red) 20%)';
        }
        return 'var(--vscode-list-inactiveSelectionBackground)';
    }
    if (isHovered || isOver) {
        if (isConflict) {
            return 'color-mix(in srgb, transparent, var(--vscode-charts-red) 20%)';
        }
        if (commit.is_divergent) {
            return 'color-mix(in srgb, transparent, var(--vscode-charts-purple) 20%)';
        }
        return 'var(--vscode-list-hoverBackground)';
    }
    if (isConflict) {
        return 'color-mix(in srgb, transparent, var(--vscode-charts-red) 10%)';
    }
    if (commit.is_divergent) {
        return 'color-mix(in srgb, transparent, var(--vscode-charts-purple) 10%)';
    }
    return undefined;
});

// Outline computation for drop target
const outline = $derived.by(() => {
    if (isOver && dragManager.activeDragItem?.type === 'commit') {
        const dropColor = dragManager.activeModifier?.accentColor || 'var(--vscode-list-activeSelectionForeground)';
        return `2px dashed ${dropColor}`;
    }
    return undefined;
});

const textOpacity = $derived(isDraggingThis ? 0.5 : 1);
const fontStyle = $derived(isImmutable ? 'italic' : 'normal');

const MAX_TOOLTIP_LENGTH = 500;
const descriptionFull = $derived.by(() => {
    let desc = commit.description.trim() || '(no description)';
    if (isEmpty) {
        desc = `(empty) ${desc}`;
    }
    return desc;
});
const descriptionFirstLine = $derived(descriptionFull.split('\n')[0]);
const descriptionTooltip = $derived(
    descriptionFull.length <= MAX_TOOLTIP_LENGTH ? descriptionFull : `${descriptionFull.slice(0, MAX_TOOLTIP_LENGTH)}…`,
);

// Change ID parts
const [idPart, offsetPart] = $derived(commit.change_id.split('/'));
const shortId = $derived(commit.change_id_shortest);
const hasShortId = $derived(shortId && idPart.startsWith(shortId));

// Active dragging bookmark check
const isDraggingBookmark = $derived(dragManager.activeDragItem?.type === 'bookmark');
const activeBookmark = $derived(
    isDraggingBookmark ? (dragManager.activeDragItem as { type: 'bookmark'; name: string; remote?: string }) : null,
);
const hasActiveBookmarkAlready = $derived(
    commit.bookmarks?.some(
        (b) => b.name === activeBookmark?.name && (b.remote ?? null) === (activeBookmark?.remote ?? null),
    ),
);
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
    class="commit-row"
    class:working-copy={isCurrentWorkingCopy}
    role="option"
    aria-selected={isSelected}
    tabindex="0"
    data-change-id={commit.change_id}
    data-selected={isSelected}
    data-hovered={isHovered}
    data-vscode-context={JSON.stringify(vscodeContext)}
    style:background-color={backgroundColor}
    style:outline={outline}
    style:opacity={textOpacity}
    use:dragManager.draggable={() => ({
        type: 'commit',
        changeId: commit.change_id,
        description: commit.description,
        change_id_shortest: commit.change_id_shortest,
    })}
    use:dragManager.droppable={() => commit.change_id}
    onclick={(e) => {
        e.stopPropagation();
        const multiSelect = e.ctrlKey || e.metaKey;
        onClick({ multiSelect });
    }}
    onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick({ multiSelect: e.ctrlKey || e.metaKey });
        }
    }}
    onmouseenter={() => (isHovered = true)}
    onmouseleave={() => (isHovered = false)}
>
    <!-- Left Column: ID and Actions -->
    <span
        class="id-actions-area"
        style:min-width={`${idDisplayLength}ch`}
    >
        <!-- Always render ID to maintain layout stability -->
        <span
            class="commit-id"
            style:color={isImmutable
                ? 'var(--vscode-descriptionForeground)'
                : 'var(--vscode-gitDecoration-addedResourceForeground)'}
        >
            {#if hasShortId && shortId}
                <span style:font-weight="bold">{shortId}</span>
                {#if idPart.length > shortId.length}
                    <span style:opacity="0.6">
                        {idPart.substring(shortId.length, idDisplayLength)}
                    </span>
                {/if}
            {:else}
                {idPart.substring(0, idDisplayLength)}
            {/if}
            {#if offsetPart}
                <span
                    style:color={commit.is_hidden
                        ? 'var(--vscode-descriptionForeground)'
                        : 'var(--vscode-charts-purple)'}
                >
                    /{offsetPart}
                </span>
            {/if}
        </span>

        <!-- Overlay Actions -->
        {#if isHovered && !dragManager.isDragging && !(selectionCount > 1)}
            <div
                class="hover-actions"
                data-vscode-context={JSON.stringify({
                    webviewSection: 'commitActions',
                    'jj.newChildVisible': visibleActions.newChild,
                    'jj.editVisible': visibleActions.edit,
                    'jj.squashVisible': visibleActions.squash,
                    'jj.abandonVisible': visibleActions.abandon,
                    preventDefaultContextMenuItems: true,
                })}
                style:background={isSelected
                    ? 'linear-gradient(var(--vscode-list-inactiveSelectionBackground), var(--vscode-list-inactiveSelectionBackground)), var(--vscode-sideBar-background)'
                    : isConflict
                      ? 'linear-gradient(color-mix(in srgb, transparent, var(--vscode-charts-red) 20%), color-mix(in srgb, transparent, var(--vscode-charts-red) 20%)), var(--vscode-sideBar-background)'
                      : 'linear-gradient(var(--vscode-list-hoverBackground), var(--vscode-list-hoverBackground)), var(--vscode-sideBar-background)'}
            >
                {#if visibleActions.newChild}
                    <IconButton
                        title="New Child"
                        icon="codicon-plus"
                        onClick={(e) => {
                            e.stopPropagation();
                            onAction('newChild', { changeId: commit.change_id });
                        }}
                        contextData={{
                            webviewSection: 'commitAction',
                            'jj.actionId': 'newChild',
                            actionTitle: 'New Child',
                        }}
                    />
                {/if}

                {#if visibleActions.edit}
                    <IconButton
                        title="Edit Commit"
                        icon="codicon-edit"
                        onClick={(e) => {
                            e.stopPropagation();
                            onAction('edit', { changeId: commit.change_id });
                        }}
                        contextData={{
                            webviewSection: 'commitAction',
                            'jj.actionId': 'edit',
                            actionTitle: 'Edit',
                        }}
                    />
                {/if}

                {#if visibleActions.squash}
                    <IconButton
                        title="Squash"
                        icon="codicon-arrow-down"
                        onClick={(e) => {
                            e.stopPropagation();
                            onAction('squash', { changeId: commit.change_id });
                        }}
                        contextData={{
                            webviewSection: 'commitAction',
                            'jj.actionId': 'squash',
                            actionTitle: 'Squash',
                        }}
                    />
                {/if}

                {#if visibleActions.abandon}
                    <IconButton
                        title="Abandon"
                        icon="codicon-trash"
                        onClick={(e) => {
                            e.stopPropagation();
                            onAction('abandon', { changeId: commit.change_id });
                        }}
                        contextData={{
                            webviewSection: 'commitAction',
                            'jj.actionId': 'abandon',
                            actionTitle: 'Abandon',
                        }}
                    />
                {/if}
            </div>
        {/if}
    </span>

    <!-- Right Column: Description, Bookmarks, Code Forge Info -->
    <div class="right-column">
        <!-- Description & Bookmarks -->
        <div class="desc-row">
            <span
                class="commit-desc"
                title={descriptionTooltip}
                style:font-weight={isCurrentWorkingCopy ? 'bold' : 'normal'}
                style:color={isImmutable
                    ? 'var(--vscode-descriptionForeground)'
                    : isEmpty
                      ? 'var(--vscode-testing-iconPassed)'
                      : !commit.description
                        ? 'var(--vscode-editorWarning-foreground)'
                        : 'inherit'}
                style:font-style={fontStyle}
            >
                {#if commit.is_divergent}
                    <span class="divergent-label">(divergent) </span>
                {/if}
                {descriptionFirstLine}
            </span>

            <!-- Right-aligned Bookmarks & Pills -->
            <span class="pills-group">
                {#if !codeForgeChange}
                    {#each commit.bookmarks || [] as bookmark (`${bookmark.name}-${bookmark.remote || 'local'}`)}
                        <DraggableBookmark {bookmark} {dragManager} />
                    {/each}
                    {#if isOver && isDraggingBookmark && activeBookmark && !hasActiveBookmarkAlready}
                        <BookmarkPill
                            bookmark={{ name: activeBookmark.name, remote: activeBookmark.remote }}
                            style="opacity: 0.7; background-color: transparent; border: 1px dashed var(--vscode-charts-blue); box-shadow: inset 0 0 8px var(--vscode-charts-blue);"
                        />
                    {/if}
                {/if}
                {#each commit.working_copies || [] as workspace (workspace)}
                    <WorkspacePill {workspace} />
                {/each}
                {#each commit.tags || [] as tag (tag)}
                    <TagPill {tag} />
                {/each}

                {#if isOver && dragManager.activeDragItem?.type === 'commit'}
                    <span
                        class="drop-badge"
                        style:background-color={dragManager.activeModifier?.accentColor || 'var(--vscode-charts-blue)'}
                    >
                        {dragManager.activeModifier?.badgeText || 'Drop here'}
                    </span>
                {/if}
            </span>
        </div>

        <!-- Code Forge Info -->
        {#if codeForgeChange}
            <div class="code-forge-row">
                {#if codeForgeChange.status === 'MERGED' || codeForgeChange.status === 'ABANDONED'}
                    <span
                        class="forge-status-badge"
                        style:border-color={codeForgeChange.status === 'MERGED'
                            ? 'var(--vscode-descriptionForeground)'
                            : 'var(--vscode-gitDecoration-ignoredResourceForeground)'}
                        style:color={codeForgeChange.status === 'MERGED'
                            ? 'var(--vscode-descriptionForeground)'
                            : 'var(--vscode-gitDecoration-ignoredResourceForeground)'}
                    >
                        {codeForgeChange.status}
                    </span>
                {/if}

                <!-- CL Link -->
                <a
                    href={codeForgeChange.url}
                    class="cl-link"
                    title={codeForgeChange.url}
                    onclick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onAction('openCodeForge', {
                            changeId: commit.change_id,
                            url: codeForgeChange.url,
                        });
                    }}
                >
                    <span>{codeForgeChange.displayLabel}</span>
                    <span class="codicon codicon-link-external cl-link-icon"></span>
                </a>

                <!-- Sync Status -->
                {#if codeForgeChange.status === 'NEW'}
                    {#if !commit.codeForgeNeedsUpload}
                        <div
                            title={codeForgeChange.parentSynced === false
                                ? 'Parent mismatch (Local parent differs from remote)'
                                : codeForgeChange.synced
                                  ? 'Synced (content matches remote)'
                                  : 'Up to date with remote'}
                            class="sync-icon-container"
                        >
                            <span class="codicon codicon-cloud"></span>
                        </div>
                    {:else}
                        <button
                            type="button"
                            onclick={(e) => {
                                e.stopPropagation();
                                onAction('upload', { changeId: commit.change_id });
                            }}
                            title={codeForgeChange.parentSynced === false
                                ? 'Parent mismatch (Click to push update)'
                                : 'Local changes need upload (Click to push)'}
                            aria-label={`Upload changes to ${codeForgeChange.providerName}`}
                            class="upload-button"
                        >
                            <span class="codicon codicon-cloud-upload"></span>
                        </button>
                    {/if}
                {/if}

                <!-- Comments -->
                {#if codeForgeChange.unresolvedComments > 0}
                    <button
                        type="button"
                        title={`${codeForgeChange.unresolvedComments} Unresolved Comments (Click to view)`}
                        onclick={(e) => {
                            e.stopPropagation();
                            onAction('showComments', { changeId: commit.change_id });
                        }}
                        class="comments-button"
                    >
                        <span class="codicon codicon-comment-discussion comments-icon"></span>
                        <span>{codeForgeChange.unresolvedComments}</span>
                    </button>
                {/if}

                <!-- Submittable -->
                {#if codeForgeChange.submittable && codeForgeChange.status === 'NEW'}
                    <span title="Ready to Submit" class="submittable-icon">
                        <span class="codicon codicon-check"></span>
                    </span>
                {/if}

                <!-- Right-aligned Bookmarks on second row -->
                <span class="pills-group" style:margin-left="auto">
                    {#each commit.bookmarks || [] as bookmark (`${bookmark.name}-${bookmark.remote || 'local'}`)}
                        <DraggableBookmark {bookmark} {dragManager} />
                    {/each}
                    {#if isOver && isDraggingBookmark && activeBookmark && !hasActiveBookmarkAlready}
                        <BookmarkPill
                            bookmark={{ name: activeBookmark.name, remote: activeBookmark.remote }}
                            style="opacity: 0.7; background-color: transparent; border: 1px dashed var(--vscode-charts-blue); box-shadow: inset 0 0 8px var(--vscode-charts-blue);"
                        />
                    {/if}
                </span>
            </div>
        {/if}
    </div>
</div>

<style>
    .commit-row {
        min-height: 28px;
        height: auto;
        display: flex;
        align-items: stretch;
        flex-direction: row;
        justify-content: flex-start;
        padding-bottom: 0;
        cursor: default;
        width: 100%;
        outline-offset: -2px;
        touch-action: none;
        min-width: 0;
        padding-left: 6px;
        padding-top: 0;
    }

    .id-actions-area {
        margin-right: 8px;
        flex-shrink: 0;
        width: auto;
        position: relative;
        display: flex;
        align-items: center;
        height: 28px;
    }

    .commit-id {
        display: flex;
        align-items: center;
        opacity: 1;
        font-family: monospace;
    }

    .hover-actions {
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        align-items: center;
        padding-right: 20px;
        mask-image: linear-gradient(to right, black 60%, transparent 100%);
        -webkit-mask-image: linear-gradient(to right, black 60%, transparent 100%);
        z-index: 1;
        height: 100%;
        padding-left: 0;
    }

    .right-column {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        justify-content: center;
    }

    .desc-row {
        display: flex;
        align-items: center;
        height: 28px;
        line-height: 28px;
        width: 100%;
    }

    .commit-desc {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-right: 8px;
        flex: 1 1 40px;
        min-width: 0;
    }

    .divergent-label {
        color: var(--vscode-charts-purple);
        margin-right: 4px;
    }

    .pills-group {
        display: flex;
        margin-left: auto;
        flex: 0 100 auto;
        gap: 4px;
        align-items: center;
        overflow: hidden;
        line-height: normal;
    }

    .drop-badge {
        color: var(--vscode-editor-background, #fff);
        font-size: 0.8em;
        font-weight: bold;
        padding: 1px 6px;
        border-radius: 3px;
        margin-left: 8px;
        white-space: nowrap;
    }

    .code-forge-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: -2px;
        overflow: hidden;
        height: 22px;
    }

    .forge-status-badge {
        border: 1px solid;
        background-color: transparent;
        padding: 0 4px;
        border-radius: 3px;
        font-weight: normal;
        font-size: inherit;
        display: inline-flex;
        align-items: center;
        opacity: 0.9;
        height: 16px;
        line-height: 14px;
    }

    .cl-link {
        color: var(--vscode-textLink-foreground);
        text-decoration: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 3px;
    }

    .cl-link-icon {
        font-size: 10px;
    }

    .sync-icon-container {
        display: flex;
        align-items: center;
        justify-content: center;
        margin-left: 4px;
        color: var(--vscode-descriptionForeground);
        cursor: default;
        width: 14px;
        height: 14px;
    }

    .upload-button {
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-left: 4px;
        color: var(--vscode-charts-yellow);
        background: none;
        border: none;
        padding: 0;
        width: 14px;
        height: 14px;
    }

    .comments-button {
        display: flex;
        align-items: center;
        gap: 3px;
        color: var(--vscode-problemsWarningIcon-foreground);
        margin-left: 4px;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
    }

    .comments-icon {
        font-size: 11px;
    }

    .submittable-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--vscode-testing-iconPassed);
        margin-left: 4px;
        width: 12px;
        height: 12px;
    }
</style>

