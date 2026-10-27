<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { ScmSnapshot } from '../../../src/core/scm-model';
import { createJjResourceState, type JjResourceState } from '../../../src/core/scm-resource-state';
import { Uri } from '../../../src/core/uri-utils';
import type { IContextKeyService } from '../menu/context-key-service';
import type { MenuRegistry } from '../menu/menu-registry';
import type { ResolvedMenuItem } from '../menu/menu-types';
import ScmHeader from './ScmHeader.svelte';
import ScmInputBox from './ScmInputBox.svelte';
import ScmResourceGroup from './ScmResourceGroup.svelte';
import { formatRepositoryDisplayNames, hasOnlyEmptyWorkingCopy, type ScmRepositoryEntry } from './scm-repo-types';

interface Props {
    snapshot: ScmSnapshot | undefined;
    workspaceRoot: string;
    repositories?: readonly ScmRepositoryEntry[];
    focusedWorkspaceRoot?: string;
    menuRegistry: MenuRegistry;
    rootContext: IContextKeyService;
    openDiffOnClick?: boolean;
    onOpenResource: (state: JjResourceState, options?: { preview?: boolean }) => void;
    onCommit: (message: string, workspaceRoot?: string) => void;
    onSetDescription: (message: string, workspaceRoot?: string) => void;
    onAction: (command: string, payload?: unknown) => void;
    onFocusRepository?: (workspaceRoot: string) => void;
    isSidecarAvailable?: boolean;
    onDraftWithAgent?: (workspaceRoot?: string) => Promise<string | undefined>;
}

let {
    snapshot,
    workspaceRoot,
    repositories,
    focusedWorkspaceRoot,
    menuRegistry,
    rootContext,
    openDiffOnClick = true,
    onOpenResource,
    onCommit,
    onSetDescription,
    onAction,
    onFocusRepository,
    isSidecarAvailable = false,
    onDraftWithAgent,
}: Props = $props();

const isMultiRepo = $derived((repositories?.length ?? 0) > 1);
const providerCount = $derived(isMultiRepo ? (repositories?.length ?? 1) : 1);
const activeFocusedRoot = $derived(focusedWorkspaceRoot || workspaceRoot);

let contextVersion = $state(0);

$effect(() => {
    const disposable = rootContext.onDidChangeContext(() => {
        contextVersion++;
    });
    return () => {
        disposable.dispose();
    };
});

// Update root context keys when snapshot or repository count changes
$effect(() => {
    rootContext.set('scmProvider', 'jj');
    rootContext.set('jj.openDiffOnClick', openDiffOnClick);
    rootContext.set('scm.providerCount', providerCount);
    if (snapshot) {
        rootContext.set('jj.parentMutable', snapshot.parentMutable);
        rootContext.set('jj.hasChild', snapshot.hasChild);
    }
});

const repoDisplayNames = $derived(formatRepositoryDisplayNames((repositories ?? []).map((r) => r.workspaceRoot)));

function buildConflictItems(snap: ScmSnapshot | undefined, root: string): JjResourceState[] {
    const changeId = snap?.currentEntry?.change_id || '@';
    return (
        snap?.conflictedPaths.map((cPath) =>
            createJjResourceState({ path: cPath, status: 'modified', conflicted: true }, '@', root, {
                openDiffOnClick,
                inConflictGroup: true,
                workingCopyChangeId: changeId,
            }),
        ) ?? []
    );
}

function buildWorkingCopyItems(snap: ScmSnapshot | undefined, root: string): JjResourceState[] {
    const changeId = snap?.currentEntry?.change_id || '@';
    const conflicted = new Set(snap?.conflictedPaths ?? []);
    return (snap?.workingCopyChanges ?? [])
        .filter((c) => !conflicted.has(c.path))
        .map((c) =>
            createJjResourceState(c, '@', root, {
                squashable: snap?.parentMutable,
                multipleAncestors: (snap?.ancestors.length ?? 0) > 1,
                openDiffOnClick,
                hasChild: snap?.hasChild,
                workingCopyChangeId: changeId,
            }),
        );
}

const currentEntry = $derived(snapshot?.currentEntry);
const currentChangeId = $derived(currentEntry?.change_id || '@');
const conflictItems = $derived(buildConflictItems(snapshot, workspaceRoot));
const workingCopyItems = $derived(buildWorkingCopyItems(snapshot, workspaceRoot));

// Single-repo draft description state
// svelte-ignore state_referenced_locally
let currentDescription = $state(snapshot?.description || '');
$effect(() => {
    if (snapshot?.description !== undefined) {
        currentDescription = snapshot.description;
    }
});

// Multi-repo draft descriptions & collapse state keyed by workspaceRoot
let descriptionsByRoot = $state<Record<string, string>>({});
let lastSyncedDescriptions = $state<Record<string, string>>({});
let collapsedByRoot = $state<Record<string, boolean>>({});
const prevEmptyOnlyByRoot = new Map<string, boolean>();

$effect(() => {
    if (!repositories) {
        return;
    }
    for (const entry of repositories) {
        const snapDesc = entry.snapshot?.description;
        if (snapDesc === undefined) {
            continue;
        }
        const prevSynced = lastSyncedDescriptions[entry.workspaceRoot];
        const currentDraft = descriptionsByRoot[entry.workspaceRoot];
        if (currentDraft === undefined || currentDraft === '' || currentDraft === prevSynced) {
            if (currentDraft !== snapDesc) {
                descriptionsByRoot[entry.workspaceRoot] = snapDesc;
            }
            if (prevSynced !== snapDesc) {
                lastSyncedDescriptions[entry.workspaceRoot] = snapDesc;
            }
        }
    }
});

$effect(() => {
    if (!repositories) {
        return;
    }
    const activeRoots = new Set(repositories.map((entry) => entry.workspaceRoot));
    for (const root of prevEmptyOnlyByRoot.keys()) {
        if (!activeRoots.has(root)) {
            prevEmptyOnlyByRoot.delete(root);
        }
    }
    for (const entry of repositories) {
        const isEmptyOnly = hasOnlyEmptyWorkingCopy(entry.snapshot);
        const prevEmptyOnly = prevEmptyOnlyByRoot.get(entry.workspaceRoot);
        if (prevEmptyOnly !== undefined && prevEmptyOnly !== isEmptyOnly) {
            collapsedByRoot[entry.workspaceRoot] = isEmptyOnly;
        }
        prevEmptyOnlyByRoot.set(entry.workspaceRoot, isEmptyOnly);
    }
});

function getRepoDescription(entry: ScmRepositoryEntry): string {
    return descriptionsByRoot[entry.workspaceRoot] ?? entry.snapshot?.description ?? '';
}

function setRepoDescription(root: string, value: string): void {
    descriptionsByRoot[root] = value;
}

function isRepoExpanded(entry: ScmRepositoryEntry): boolean {
    return !(collapsedByRoot[entry.workspaceRoot] ?? hasOnlyEmptyWorkingCopy(entry.snapshot));
}

function toggleRepoExpanded(entry: ScmRepositoryEntry): void {
    collapsedByRoot[entry.workspaceRoot] = isRepoExpanded(entry);
}

function getRepoTitleActions(entry: ScmRepositoryEntry): ResolvedMenuItem[] {
    if (contextVersion < 0) {
        return [];
    }
    const scoped = rootContext.createScoped({
        scmProvider: 'jj',
        'scm.providerCount': providerCount,
        'jj.parentMutable': entry.snapshot?.parentMutable ?? false,
        'jj.hasChild': entry.snapshot?.hasChild ?? false,
    });
    return menuRegistry.getInlineActions('scm/title', scoped);
}
</script>

<div class="scm-pane" data-testid="scm-pane">
    <ScmHeader
        {menuRegistry}
        context={rootContext}
        showActions={!isMultiRepo}
        onAction={(cmd) => {
            if (cmd === 'jj-view.commit') {
                const msg = currentDescription;
                currentDescription = '';
                onCommit(msg);
            } else if (cmd === 'jj-view.setDescription') {
                onSetDescription(currentDescription);
            } else {
                onAction(cmd);
            }
        }}
    />

    {#if isMultiRepo && repositories}
        <div class="scm-repositories-list" role="tree" aria-label="Source Control Repositories">
            {#each repositories as entry (entry.workspaceRoot)}
                {@const root = entry.workspaceRoot}
                {@const snap = entry.snapshot}
                {@const repoEntry = snap?.currentEntry}
                {@const repoChangeId = repoEntry?.change_id || '@'}
                {@const shortChangeId = repoEntry?.change_id_shortest || repoEntry?.change_id?.slice(0, 8)}
                {@const bookmarkName = repoEntry?.bookmarks?.[0]?.name}
                {@const repoConflicts = buildConflictItems(snap, root)}
                {@const repoWorkingCopy = buildWorkingCopyItems(snap, root)}
                {@const totalChanges = repoConflicts.length + repoWorkingCopy.length}
                {@const display = repoDisplayNames.get(root) ?? { name: root.split(/[/\\]/).pop() || root }}
                {@const displayLabel = display.qualifier ? `${display.qualifier}/${display.name}` : display.name}
                {@const isFocused = root === activeFocusedRoot}
                {@const expanded = isRepoExpanded(entry)}
                {@const repoActions = getRepoTitleActions(entry)}
                {@const repoVsCodeContext = JSON.stringify({
                    menuId: 'scm/title',
                    scmProvider: 'jj',
                    'scm.providerCount': providerCount,
                    preventDefaultContextMenuItems: true,
                    rootUri: Uri.file(root),
                })}

                <section
                    class="scm-repository-section"
                    class:focused={isFocused}
                    data-testid="scm-repository-section"
                    data-repo-root={root}
                    data-focused={isFocused ? 'true' : 'false'}
                >
                    <div
                        class="scm-repository-header"
                        data-testid="scm-repository-header"
                        data-vscode-context={repoVsCodeContext}
                        role="button"
                        tabindex="0"
                        aria-expanded={expanded}
                        onclick={() => toggleRepoExpanded(entry)}
                        onkeydown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleRepoExpanded(entry);
                            }
                        }}
                    >
                        <div class="repo-header-title" title={root}>
                            <span class="chevron-icon">
                                <i
                                    class={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`}
                                    aria-hidden="true"
                                ></i>
                            </span>
                            <i class="codicon codicon-repo repo-icon" aria-hidden="true"></i>
                            <span class="repo-name" data-testid="scm-repository-name">{displayLabel}</span>
                            {#if shortChangeId}
                                <span class="repo-revision-summary">
                                    {shortChangeId}{bookmarkName ? ` (${bookmarkName})` : ''}
                                </span>
                            {/if}
                            {#if isFocused}
                                <span
                                    class="repo-focused-indicator"
                                    data-testid="scm-repository-focused-badge"
                                    title="Active in Commit Graph"
                                >
                                    Active
                                </span>
                            {/if}
                        </div>

                        <div class="repo-header-actions">
                            <div class="repo-toolbar" role="toolbar" aria-label={`Actions for ${displayLabel}`}>
                                {#each repoActions as action (action.command)}
                                    <button
                                        type="button"
                                        class="icon-button repo-action-button"
                                        data-testid={`scm-title-action-${action.command}`}
                                        title={action.title}
                                        aria-label={action.title}
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            onFocusRepository?.(root);
                                            if (action.command === 'jj-view.commit') {
                                                const msg = getRepoDescription(entry);
                                                setRepoDescription(root, '');
                                                onCommit(msg, root);
                                            } else if (action.command === 'jj-view.setDescription') {
                                                onSetDescription(getRepoDescription(entry), root);
                                            } else {
                                                onAction(action.command, { rootUri: Uri.file(root) });
                                            }
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
                            {#if !expanded && totalChanges > 0}
                                <span class="repo-count-badge" title={`${totalChanges} working copy changes`}>
                                    {totalChanges}
                                </span>
                            {/if}
                        </div>
                    </div>

                    {#if expanded}
                        <div class="scm-repository-body">
                            <ScmInputBox
                                value={snap?.description || ''}
                                changeId={repoEntry?.change_id}
                                {isSidecarAvailable}
                                onDraftWithAgent={onDraftWithAgent ? () => onDraftWithAgent(root) : undefined}
                                onCommit={(msg) => {
                                    onFocusRepository?.(root);
                                    setRepoDescription(root, '');
                                    onCommit(msg, root);
                                }}
                                onSetDescription={(msg) => {
                                    onFocusRepository?.(root);
                                    onSetDescription(msg, root);
                                }}
                                onValueChange={(val) => {
                                    setRepoDescription(root, val);
                                }}
                            />

                            <div class="scm-groups-list" role="group">
                                {#if repoConflicts.length > 0}
                                    <ScmResourceGroup
                                        id="conflicts"
                                        label="Merge Conflicts"
                                        contextValue="jj.group.conflict"
                                        items={repoConflicts}
                                        workspaceRoot={root}
                                        expanded={true}
                                        {rootContext}
                                        {menuRegistry}
                                        onGroupAction={(cmd) => {
                                            onFocusRepository?.(root);
                                            onAction(cmd, { groupId: 'conflicts', rootUri: Uri.file(root) });
                                        }}
                                        onOpenResource={(state, opts) => {
                                            onFocusRepository?.(root);
                                            onOpenResource(state, opts);
                                        }}
                                        onResourceAction={(cmd, item) => {
                                            onFocusRepository?.(root);
                                            onAction(cmd, item);
                                        }}
                                    />
                                {/if}

                                <ScmResourceGroup
                                    id="working-copy"
                                    label={snap?.workingCopyLabel || 'Working Copy'}
                                    contextValue={snap?.workingCopyContextValue || 'jj.group.workingCopy'}
                                    items={repoWorkingCopy}
                                    workspaceRoot={root}
                                    expanded={true}
                                    {rootContext}
                                    {menuRegistry}
                                    onGroupAction={(cmd) => {
                                        onFocusRepository?.(root);
                                        onAction(cmd, { groupId: 'working-copy', rootUri: Uri.file(root) });
                                    }}
                                    onOpenResource={(state, opts) => {
                                        onFocusRepository?.(root);
                                        onOpenResource(state, opts);
                                    }}
                                    onResourceAction={(cmd, item) => {
                                        onFocusRepository?.(root);
                                        onAction(cmd, item);
                                    }}
                                />

                                {#if snap?.ancestors}
                                    {#each snap.ancestors as ancestor, idx (ancestor.prefix)}
                                        {@const remainingAncestors = snap.ancestors.length - 1 - idx}
                                        {@const ancestorItems = ancestor.changes.map((c) =>
                                            createJjResourceState(c, ancestor.entry.change_id, root, {
                                                editable: ancestor.isMutable,
                                                squashable: ancestor.canSquash,
                                                multipleAncestors: remainingAncestors > 0,
                                                openDiffOnClick,
                                                workingCopyChangeId: repoChangeId,
                                            }),
                                        )}
                                        <ScmResourceGroup
                                            id={`ancestor-${idx}`}
                                            label={ancestor.label}
                                            contextValue={ancestor.contextValue}
                                            items={ancestorItems}
                                            workspaceRoot={root}
                                            expanded={true}
                                            {rootContext}
                                            {menuRegistry}
                                            onGroupAction={(cmd) => {
                                                onFocusRepository?.(root);
                                                onAction(cmd, {
                                                    ancestor,
                                                    groupId: `ancestor-${idx}`,
                                                    revision: ancestor.entry.change_id,
                                                    changeId: ancestor.entry.change_id,
                                                    commitId: ancestor.entry.commit_id,
                                                    rootUri: Uri.file(root),
                                                });
                                            }}
                                            revision={ancestor.entry.change_id}
                                            changeId={ancestor.entry.change_id}
                                            commitId={ancestor.entry.commit_id}
                                            onOpenResource={(state, opts) => {
                                                onFocusRepository?.(root);
                                                onOpenResource(state, opts);
                                            }}
                                            onResourceAction={(cmd, item) => {
                                                onFocusRepository?.(root);
                                                onAction(cmd, item);
                                            }}
                                        />
                                    {/each}
                                {/if}
                            </div>
                        </div>
                    {/if}
                </section>
            {/each}
        </div>
    {:else}
        <ScmInputBox
            value={snapshot?.description || ''}
            changeId={currentEntry?.change_id}
            {isSidecarAvailable}
            onDraftWithAgent={onDraftWithAgent ? () => onDraftWithAgent(workspaceRoot) : undefined}
            onCommit={(msg) => {
                currentDescription = '';
                onCommit(msg);
            }}
            onSetDescription={(msg) => onSetDescription(msg)}
            onValueChange={(val) => {
                currentDescription = val;
            }}
        />

        <div class="scm-groups-list" role="tree" aria-label="Source Control Repositories">
            {#if conflictItems.length > 0}
                <ScmResourceGroup
                    id="conflicts"
                    label="Merge Conflicts"
                    contextValue="jj.group.conflict"
                    items={conflictItems}
                    {workspaceRoot}
                    expanded={true}
                    {rootContext}
                    {menuRegistry}
                    onGroupAction={(cmd) => onAction(cmd, { groupId: 'conflicts' })}
                    onOpenResource={onOpenResource}
                    onResourceAction={(cmd, item) => onAction(cmd, item)}
                />
            {/if}

            <ScmResourceGroup
                id="working-copy"
                label={snapshot?.workingCopyLabel || 'Working Copy'}
                contextValue={snapshot?.workingCopyContextValue || 'jj.group.workingCopy'}
                items={workingCopyItems}
                {workspaceRoot}
                expanded={true}
                {rootContext}
                {menuRegistry}
                onGroupAction={(cmd) => onAction(cmd, { groupId: 'working-copy' })}
                onOpenResource={onOpenResource}
                onResourceAction={(cmd, item) => onAction(cmd, item)}
            />

            {#if snapshot?.ancestors}
                {#each snapshot.ancestors as ancestor, idx (ancestor.prefix)}
                    {@const remainingAncestors = snapshot.ancestors.length - 1 - idx}
                    {@const ancestorItems = ancestor.changes.map((c) =>
                        createJjResourceState(c, ancestor.entry.change_id, workspaceRoot, {
                            editable: ancestor.isMutable,
                            squashable: ancestor.canSquash,
                            multipleAncestors: remainingAncestors > 0,
                            openDiffOnClick,
                            workingCopyChangeId: currentChangeId,
                        }),
                    )}
                    <ScmResourceGroup
                        id={`ancestor-${idx}`}
                        label={ancestor.label}
                        contextValue={ancestor.contextValue}
                        items={ancestorItems}
                        {workspaceRoot}
                        expanded={true}
                        {rootContext}
                        {menuRegistry}
                        onGroupAction={(cmd) =>
                            onAction(cmd, {
                                ancestor,
                                groupId: `ancestor-${idx}`,
                                revision: ancestor.entry.change_id,
                                changeId: ancestor.entry.change_id,
                                commitId: ancestor.entry.commit_id,
                            })}
                        revision={ancestor.entry.change_id}
                        changeId={ancestor.entry.change_id}
                        commitId={ancestor.entry.commit_id}
                        onOpenResource={onOpenResource}
                        onResourceAction={(cmd, item) => onAction(cmd, item)}
                    />
                {/each}
            {/if}
        </div>
    {/if}
</div>

<style>
.scm-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background-color: var(--vscode-sideBar-background, #171717);
    color: var(--vscode-foreground, #d4d4d4);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    overflow-y: auto;
    overflow-x: hidden;
    user-select: none;
}

.scm-groups-list {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
}

.scm-repositories-list {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
}

.scm-repository-section {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder);
}

.scm-repository-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 26px;
    min-height: 26px;
    padding: 0 10px 0 6px;
    background-color: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorGroupHeader-tabsBackground));
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    border-left: 2px solid transparent;
    cursor: pointer;
    box-sizing: border-box;
    transition: background-color 0.1s ease, border-color 0.1s ease;
}

.scm-repository-section.focused > .scm-repository-header {
    border-left-color: var(--vscode-focusBorder);
}

.scm-repository-header:hover {
    background-color: var(--vscode-list-hoverBackground);
}

.scm-repository-header:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
}

.repo-header-title {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    white-space: nowrap;
}

.chevron-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    font-size: 16px;
    color: var(--vscode-icon-foreground);
    flex-shrink: 0;
}

.repo-icon {
    font-size: 14px;
    color: var(--vscode-icon-foreground);
    flex-shrink: 0;
}

.repo-name {
    font-weight: 600;
    font-size: 12px;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
}

.repo-revision-summary {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
}

.repo-focused-indicator {
    font-size: 10px;
    font-weight: 600;
    padding: 0 5px;
    height: 15px;
    line-height: 15px;
    border-radius: 4px;
    color: var(--vscode-focusBorder);
    background-color: color-mix(in srgb, var(--vscode-focusBorder) 15%, transparent);
    flex-shrink: 0;
}

.repo-header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
}

.repo-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
}

.repo-action-button {
    background: transparent;
    color: var(--vscode-icon-foreground);
    border: none;
    border-radius: 4px;
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    font-size: 13px;
    transition: background-color 0.15s, color 0.15s;
}

.repo-action-button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-foreground);
}

.repo-action-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
}

.repo-count-badge {
    background-color: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 11px;
    padding: 0 6px;
    font-size: 11px;
    font-weight: 600;
    min-width: 18px;
    height: 18px;
    line-height: 18px;
    text-align: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.scm-repository-body {
    display: flex;
    flex-direction: column;
}
</style>
