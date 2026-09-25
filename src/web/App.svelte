<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { onMount } from 'svelte';
import type { RemoteHostSystem } from '../core/host/remote-host-system';
import type { ScmModel, ScmSnapshot } from '../core/scm-model';
import type { JjResourceState } from '../core/scm-resource-state';
import type { Uri } from '../core/uri-utils';
import { WebCommandDispatcher } from './commands/web-command-dispatcher';
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

const dispatcher: WebCommandDispatcher | null = $derived.by(() => {
    if (!scmModel) {
        return null;
    }
    return new WebCommandDispatcher({
        scmModel,
        onOpenDiff: (leftUri, rightUri, title) => {
            activeDiffLeftUri = leftUri;
            activeDiffRightUri = rightUri;
            activeDiffTitle = title || 'Diff';
        },
        onOpenFile: (uri) => {
            activeDiffLeftUri = undefined;
            activeDiffRightUri = uri;
            activeDiffTitle = uri.path;
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

function handleAction(command: string, payload?: unknown): void {
    if (dispatcher) {
        dispatcher.execute(command, payload);
        return;
    }

    if (command === 'vscode.diff' || command === 'jj-view.openChanges') {
        const item = payload as JjResourceState | undefined;
        if (item) {
            activeDiffTitle = item.diffTitle || item.resourceUri.path;
            activeDiffLeftUri = item.leftUri;
            activeDiffRightUri = item.rightUri;
        }
    }
}

function handleOpenResource(state: JjResourceState): void {
    if (state.command) {
        handleAction(state.command.command, state);
    } else {
        activeDiffTitle = state.diffTitle || state.resourceUri.path;
    }
}

function handleCommit(message: string): void {
    handleAction('jj-view.commit', message);
}

function handleSetDescription(message: string): void {
    handleAction('jj-view.setDescription', message);
}

function handleRefresh(): void {
    handleAction('jj-view.refresh');
}

onMount(() => {
    // If host is provided and connected, we could wire JjService / ScmModel
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
                <div class="editor-header">
                    <span>{activeDiffTitle}</span>
                </div>
                <div class="diff-placeholder">
                    <p>Viewing: {activeDiffTitle}</p>
                </div>
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
