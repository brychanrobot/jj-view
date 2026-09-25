<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { ScmSnapshot } from '../../../src/core/scm-model';
import { createJjResourceState, type JjResourceState } from '../../../src/core/scm-resource-state';
import type { IContextKeyService } from '../menu/context-key-service';
import type { MenuRegistry } from '../menu/menu-registry';
import type { ResolvedMenuItemGroup } from '../menu/menu-types';
import ScmContextMenu from './ScmContextMenu.svelte';
import ScmHeader from './ScmHeader.svelte';
import ScmInputBox from './ScmInputBox.svelte';
import ScmResourceGroup from './ScmResourceGroup.svelte';

interface Props {
    snapshot: ScmSnapshot | undefined;
    workspaceRoot: string;
    menuRegistry: MenuRegistry;
    rootContext: IContextKeyService;
    openDiffOnClick?: boolean;
    onOpenResource: (state: JjResourceState) => void;
    onCommit: (message: string) => void;
    onSetDescription: (message: string) => void;
    onAction: (command: string, payload?: unknown) => void;
}

let {
    snapshot,
    workspaceRoot,
    menuRegistry,
    rootContext,
    openDiffOnClick = true,
    onOpenResource,
    onCommit,
    onSetDescription,
    onAction,
}: Props = $props();

let contextMenuState = $state<{
    visible: boolean;
    x: number;
    y: number;
    groups: ResolvedMenuItemGroup[];
    payload?: unknown;
}>({
    visible: false,
    x: 0,
    y: 0,
    groups: [],
});

// Update root context keys when snapshot changes
$effect(() => {
    rootContext.set('scmProvider', 'jj');
    rootContext.set('jj.openDiffOnClick', openDiffOnClick);
    if (snapshot) {
        rootContext.set('jj.parentMutable', snapshot.parentMutable);
        rootContext.set('jj.hasChild', snapshot.hasChild);
        rootContext.set('scm.providerCount', 1);
    }
});

const currentEntry = $derived(snapshot?.currentEntry);
const currentChangeId = $derived(currentEntry?.change_id || '@');

const conflictItems: JjResourceState[] = $derived(
    snapshot?.conflictedPaths.map((cPath) =>
        createJjResourceState({ path: cPath, status: 'modified', conflicted: true }, '@', workspaceRoot, {
            openDiffOnClick,
            inConflictGroup: true,
            workingCopyChangeId: currentChangeId,
        }),
    ) ?? [],
);

const conflictedSet = $derived(new Set(snapshot?.conflictedPaths ?? []));

const workingCopyItems: JjResourceState[] = $derived(
    (snapshot?.workingCopyChanges ?? [])
        .filter((c) => !conflictedSet.has(c.path))
        .map((c) =>
            createJjResourceState(c, '@', workspaceRoot, {
                squashable: snapshot?.parentMutable,
                multipleAncestors: (snapshot?.ancestors.length ?? 0) > 1,
                openDiffOnClick,
                hasChild: snapshot?.hasChild,
                workingCopyChangeId: currentChangeId,
            }),
        ),
);

function handleGroupContextMenu(
    e: MouseEvent,
    groupId: string,
    contextValue: string,
    extraPayload?: Record<string, unknown>,
): void {
    e.preventDefault();
    const groupCtx = rootContext.createScoped({
        scmResourceGroupState: contextValue,
        scmResourceGroupId: groupId,
    });
    const groups = menuRegistry.getContextActions('scm/resourceGroup/context', groupCtx);
    if (groups.length > 0) {
        contextMenuState = {
            visible: true,
            x: e.clientX,
            y: e.clientY,
            groups,
            payload: { groupId, ...extraPayload },
        };
    }
}

function handleResourceContextMenu(e: MouseEvent, resourceState: JjResourceState): void {
    e.preventDefault();
    const itemCtx = rootContext.createScoped({
        scmResourceState: resourceState.contextValue || '',
        resourceFilename: resourceState.resourceUri.path.split('/').pop() || '',
        resourceScheme: resourceState.resourceUri.scheme,
    });
    const groups = menuRegistry.getContextActions('scm/resourceState/context', itemCtx);
    if (groups.length > 0) {
        contextMenuState = {
            visible: true,
            x: e.clientX,
            y: e.clientY,
            groups,
            payload: resourceState,
        };
    }
}
// svelte-ignore state_referenced_locally
let currentDescription = $state(snapshot?.description || '');
$effect(() => {
    if (snapshot?.description !== undefined) {
        currentDescription = snapshot.description;
    }
});
</script>

<div class="scm-pane" data-testid="scm-pane">
    <ScmHeader
        {menuRegistry}
        context={rootContext}
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

    <ScmInputBox
        value={snapshot?.description || ''}
        changeId={currentChangeId}
        onCommit={(msg) => {
            currentDescription = '';
            onCommit(msg);
        }}
        {onSetDescription}
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
                expanded={true}
                {rootContext}
                {menuRegistry}
                onGroupAction={(cmd) => onAction(cmd, { groupId: 'conflicts' })}
                onOpenResource={onOpenResource}
                onResourceAction={(cmd, item) => onAction(cmd, item)}
                onGroupContextMenu={(e) => handleGroupContextMenu(e, 'conflicts', 'jj.group.conflict')}
                onResourceContextMenu={handleResourceContextMenu}
            />
        {/if}

        <ScmResourceGroup
            id="working-copy"
            label={snapshot?.workingCopyLabel || 'Working Copy'}
            contextValue={snapshot?.workingCopyContextValue || 'jj.group.workingCopy'}
            items={workingCopyItems}
            expanded={true}
            {rootContext}
            {menuRegistry}
            onGroupAction={(cmd) => onAction(cmd, { groupId: 'working-copy' })}
            onOpenResource={onOpenResource}
            onResourceAction={(cmd, item) => onAction(cmd, item)}
            onGroupContextMenu={(e) =>
                handleGroupContextMenu(e, 'working-copy', snapshot?.workingCopyContextValue || 'jj.group.workingCopy')}
            onResourceContextMenu={handleResourceContextMenu}
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
                    onOpenResource={onOpenResource}
                    onResourceAction={(cmd, item) => onAction(cmd, item)}
                    onGroupContextMenu={(e) =>
                        handleGroupContextMenu(e, `ancestor-${idx}`, ancestor.contextValue, {
                            ancestor,
                            revision: ancestor.entry.change_id,
                            changeId: ancestor.entry.change_id,
                            commitId: ancestor.entry.commit_id,
                        })}
                    onResourceContextMenu={handleResourceContextMenu}
                />
            {/each}
        {/if}
    </div>

    {#if contextMenuState.visible}
        <ScmContextMenu
            x={contextMenuState.x}
            y={contextMenuState.y}
            groups={contextMenuState.groups}
            onSelect={(cmd) => onAction(cmd, contextMenuState.payload)}
            onClose={() => {
                contextMenuState = { ...contextMenuState, visible: false, payload: undefined };
            }}
        />
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
</style>
