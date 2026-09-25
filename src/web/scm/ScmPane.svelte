<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { ScmSnapshot } from '../../core/scm-model';
import { createJjResourceState, type JjResourceState } from '../../core/scm-resource-state';
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
        createJjResourceState({ path: cPath, status: 'modified', conflicted: true }, currentChangeId, workspaceRoot, {
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
            createJjResourceState(c, currentChangeId, workspaceRoot, {
                squashable: snapshot?.parentMutable,
                multipleAncestors: (snapshot?.ancestors.length ?? 0) > 1,
                openDiffOnClick,
                hasChild: snapshot?.hasChild,
                workingCopyChangeId: currentChangeId,
            }),
        ),
);

function handleGroupContextMenu(e: MouseEvent, groupId: string, contextValue: string): void {
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
        };
    }
}
</script>

<div class="scm-pane" data-testid="scm-pane">
    <ScmHeader
        {menuRegistry}
        context={rootContext}
        onAction={(cmd) => onAction(cmd)}
    />

    <ScmInputBox
        value={snapshot?.description || ''}
        {onCommit}
        {onSetDescription}
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
                    onGroupAction={(cmd) => onAction(cmd, { ancestor, groupId: `ancestor-${idx}` })}
                    onOpenResource={onOpenResource}
                    onResourceAction={(cmd, item) => onAction(cmd, item)}
                    onGroupContextMenu={(e) => handleGroupContextMenu(e, `ancestor-${idx}`, ancestor.contextValue)}
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
            onSelect={(cmd) => onAction(cmd)}
            onClose={() => {
                contextMenuState = { ...contextMenuState, visible: false };
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
    background-color: var(--vscode-sideBar-background, #1e1e1e);
    color: var(--vscode-sideBar-foreground, #cccccc);
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
