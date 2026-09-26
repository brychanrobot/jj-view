<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { ScmSnapshot } from '../../../src/core/scm-model';
import { createJjResourceState, type JjResourceState } from '../../../src/core/scm-resource-state';
import type { IContextKeyService } from '../menu/context-key-service';
import type { MenuRegistry } from '../menu/menu-registry';
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
    gap: 6px;
}
</style>
