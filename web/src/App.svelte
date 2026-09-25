<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { onMount } from 'svelte';
import type { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import type { ScmModel, ScmSnapshot } from '../../src/core/scm-model';
import type { JjResourceState } from '../../src/core/scm-resource-state';
import { isWorkingCopyRevision, type Uri } from '../../src/core/uri-utils';
import { WebCommandDispatcher } from './commands/web-command-dispatcher';
import PierreDiffViewer from './diff/PierreDiffViewer.svelte';
import AppLayout from './layout/AppLayout.svelte';
import { ContextKeyService } from './menu/context-key-service';
import { MenuRegistry } from './menu/menu-registry';
import ScmPane from './scm/ScmPane.svelte';

interface Props {
    host?: RemoteHostSystem;
    scmModel?: ScmModel;
    initialSnapshot?: ScmSnapshot;
    workspaceRoot?: string;
}

let { host, scmModel, initialSnapshot, workspaceRoot = '' }: Props = $props();

const menuRegistry = new MenuRegistry();
const rootContext = new ContextKeyService();

let currentSnapshot: ScmSnapshot | undefined = $state(initialSnapshot ?? scmModel?.snapshot);
let activeTab: 'scm' | 'log' = $state('scm');
let activeDiffTitle: string | null = $state(null);
let activeDiffLeftUri: Uri | undefined = $state(undefined);
let activeDiffRightUri: Uri | undefined = $state(undefined);
let activeResourceState: JjResourceState | null = $state(null);
let originalContent = $state('');
let modifiedContent = $state('');

async function loadDiffFromUris(
    leftUri?: Uri,
    rightUri?: Uri,
    title?: string,
    resourceState?: JjResourceState,
): Promise<void> {
    activeResourceState = resourceState ?? null;
    activeDiffLeftUri = leftUri;
    activeDiffRightUri = rightUri;
    activeDiffTitle = title || rightUri?.path || 'Diff';

    if (!host) {
        return;
    }

    try {
        if (leftUri) {
            const leftData = await host.fs.readFile(leftUri.path);
            originalContent = typeof leftData === 'string' ? leftData : new TextDecoder().decode(leftData);
        } else {
            originalContent = '';
        }

        if (rightUri) {
            const rightData = await host.fs.readFile(rightUri.path);
            modifiedContent = typeof rightData === 'string' ? rightData : new TextDecoder().decode(rightData);
        } else {
            modifiedContent = '';
        }
    } catch (err) {
        console.error('Failed to load file contents for diff:', err);
    }
}

async function loadDiffContents(state: JjResourceState): Promise<void> {
    await loadDiffFromUris(state.leftUri, state.rightUri, state.diffTitle || state.resourceUri.path, state);
}

async function handleSaveFile(newContent: string): Promise<void> {
    if (!host || !activeDiffRightUri) {
        return;
    }
    const encoder = new TextEncoder();
    await host.fs.writeFile(activeDiffRightUri.path, encoder.encode(newContent));
    modifiedContent = newContent;
    if (scmModel) {
        await scmModel.refresh({ reason: 'save-diff' });
    }
}

async function handleDiscardFile(): Promise<void> {
    if (!activeResourceState) {
        return;
    }
    await handleAction('jj-view.restore', activeResourceState);
    if (scmModel) {
        await scmModel.refresh({ reason: 'discard-file' });
    }
    await loadDiffContents(activeResourceState);
}

async function handleResolveConflict(): Promise<void> {
    if (!activeResourceState) {
        return;
    }
    if (scmModel) {
        await scmModel.refresh({ reason: 'resolve-conflict' });
    }
    await loadDiffContents(activeResourceState);
}

const dispatcher: WebCommandDispatcher | null = $derived.by(() => {
    if (!scmModel) {
        return null;
    }
    return new WebCommandDispatcher({
        scmModel,
        onOpenDiff: async (leftUri, rightUri, title) => {
            await loadDiffFromUris(leftUri, rightUri, title, activeResourceState ?? undefined);
        },
        onOpenFile: async (uri) => {
            await loadDiffFromUris(undefined, uri, uri.path, activeResourceState ?? undefined);
        },
        onError: (err) => {
            console.error('Command execution failed:', err);
        },
    });
});

$effect(() => {
    if (!scmModel) {
        return;
    }
    const disposable = scmModel.onDidChange(() => {
        currentSnapshot = scmModel.snapshot;
    });
    return () => {
        disposable.dispose();
    };
});

async function handleAction(command: string, payload?: unknown): Promise<void> {
    if (payload && typeof payload === 'object' && 'resourceUri' in (payload as Record<string, unknown>)) {
        activeResourceState = payload as JjResourceState;
    }
    if (dispatcher) {
        await dispatcher.execute(command, payload);
        return;
    }

    if (command === 'vscode.diff' || command === 'jj-view.openChanges') {
        const item = payload as JjResourceState | undefined;
        if (item) {
            await loadDiffContents(item);
        }
    }
}

async function handleOpenResource(state: JjResourceState): Promise<void> {
    if (state.command) {
        await handleAction(state.command.command, state);
    } else {
        await loadDiffContents(state);
    }
}

function handleCommit(message: string): void {
    void handleAction('jj-view.commit', message);
}

function handleSetDescription(message: string): void {
    void handleAction('jj-view.describe', message);
}

function handleRefresh(): void {
    void handleAction('jj-view.refresh');
}

onMount(() => {
    return () => {
        rootContext.dispose();
    };
});
</script>

<AppLayout
    repoPath={workspaceRoot}
    {activeTab}
    onTabChange={(tab) => {
        activeTab = tab;
    }}
    onRefresh={handleRefresh}
>
    {#snippet sidebar()}
        {#if activeTab === 'scm'}
            <ScmPane
                snapshot={currentSnapshot}
                {workspaceRoot}
                {menuRegistry}
                {rootContext}
                openDiffOnClick={true}
                onOpenResource={handleOpenResource}
                onCommit={handleCommit}
                onSetDescription={handleSetDescription}
                onAction={handleAction}
            />
        {:else}
            <div class="log-placeholder" data-testid="log-pane-placeholder">
                <p>JJ Log View</p>
            </div>
        {/if}
    {/snippet}

    {#snippet main()}
        <div class="editor-main-area" data-testid="editor-main-area">
            {#if activeDiffTitle}
                {#key activeDiffTitle}
                    <PierreDiffViewer
                        filename={activeDiffTitle}
                        {originalContent}
                        {modifiedContent}
                        isWorkingCopy={activeResourceState
                            ? isWorkingCopyRevision(
                                  activeResourceState.revision,
                                  currentSnapshot?.currentEntry?.change_id
                              )
                            : true}
                        isConflict={activeResourceState?.status === 'conflicted' ||
                            (activeResourceState?.contextValue?.includes('AllowOpenMergeEditor') ?? false)}
                        onSave={handleSaveFile}
                        onDiscard={handleDiscardFile}
                        onResolveConflict={handleResolveConflict}
                    />
                {/key}
            {:else}
                <div class="empty-editor-message">
                    <i class="codicon codicon-source-control large-icon" aria-hidden="true"></i>
                    <h2>Source Control (JJ View)</h2>
                    <p>Select a changed file in the left pane to view diffs and make edits.</p>
                </div>
            {/if}
        </div>
    {/snippet}
</AppLayout>

<style>
.editor-main-area {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background-color: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #cccccc);
}

.editor-header {
    height: 35px;
    padding: 0 16px;
    display: flex;
    align-items: center;
    background-color: var(--vscode-editorGroupHeader-tabsBackground, #252526);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, rgba(128, 128, 128, 0.2));
    font-size: 13px;
    font-weight: 500;
}

.diff-placeholder {
    padding: 24px;
    font-family: monospace;
}

.empty-editor-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    color: var(--vscode-descriptionForeground, #888888);
    text-align: center;
    user-select: none;
}

.empty-editor-message h2 {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
    color: var(--vscode-foreground, #ffffff);
}

.empty-editor-message p {
    font-size: 13px;
    margin: 0;
    max-width: 360px;
    line-height: 1.5;
}

.large-icon {
    font-size: 48px;
    color: var(--vscode-icon-foreground, #777777);
    margin-bottom: 8px;
}

.log-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--vscode-descriptionForeground, #888888);
}
</style>
