<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { ScmSnapshot } from '../../../src/core/scm-model';
import type { JjResourceState } from '../../../src/core/scm-resource-state';
import { isWorkingCopyRevision } from '../../../src/core/uri-utils';
import type { OutputChannel } from '../../../src/utils/output-channel';
import type { InMemoryBridge } from '../bridge/in-memory-bridge';
import CommentsPane from '../comments/CommentsPane.svelte';
import type { CommentsStore, CommentThreadHandle } from '../comments/comments-store.svelte';
import CommitDetailsView from '../details/CommitDetailsView.svelte';
import type { EditorChatContextSelection } from '../diff/chat-context-selection';
import PierreDiffViewer from '../diff/PierreDiffViewer.svelte';
import PierreFileViewer from '../diff/PierreFileViewer.svelte';
import PierreMultiDiffViewer from '../diff/PierreMultiDiffViewer.svelte';
import MergeEditorView from '../merge/MergeEditorView.svelte';
import ProcessMonitorView from '../monitor/ProcessMonitorView.svelte';
import OutputPane from '../output/OutputPane.svelte';
import type { WebOutputChannel } from '../output/web-output-channel';
import { COMMENTS_TAB_ID, OUTPUT_TAB_ID, PROCESS_MONITOR_TAB_ID, type TabEntry } from '../tabs/tab-types';
import type { CommitDetailsSession } from './tab-document-manager.svelte';

interface ChatContextSelectionProvider {
    getChatContextSelection: () => EditorChatContextSelection | null;
}

interface EditorWorkspaceProps {
    activeTab: TabEntry | undefined;
    activeTheme: string;
    currentSnapshot: ScmSnapshot | undefined;
    activeDiffThreads: CommentThreadHandle[];
    activeMultiDiffThreads: ReadonlyMap<string, readonly CommentThreadHandle[]>;
    commentsStore: CommentsStore | undefined;
    activeOutputChannel: OutputChannel | WebOutputChannel;
    processMonitorBridge: InMemoryBridge;
    activeCommitDetailsSession: CommitDetailsSession | undefined;
    onDirtyChange: (dirty: boolean) => void;
    onContentChange: (content: string) => void;
    onSaveFile: (newContent: string) => Promise<void>;
    onDiscardFile: () => Promise<void>;
    onResolveConflict: () => Promise<void>;
    onOpenMergeEditor: (resource: JjResourceState) => void;
    onCompleteMerge: (resolvedContent: string) => Promise<void>;
    onOpenTwoWayDiff: (resource: JjResourceState) => void;
    onSquashSelection: (ranges: { startLine: number; endLine: number }[]) => Promise<void>;
    onAddSelectionToChat: (selection?: EditorChatContextSelection) => Promise<void>;
    onReplyToThread: (handle: CommentThreadHandle, text: string, resolve: boolean) => Promise<void>;
    onSetThreadResolved: (handle: CommentThreadHandle, resolved: boolean) => Promise<void>;
    onOpenThreadLocation: (handle: CommentThreadHandle) => void;
    onCloseTab: (id: string) => void;
    onSelectionChange: (ranges: { startLine: number; endLine: number }[] | undefined) => void;
    onCopyUnresolvedComments?: () => void;
    onRefreshComments?: () => void;
}

let {
    activeTab,
    activeTheme,
    currentSnapshot,
    activeDiffThreads,
    activeMultiDiffThreads,
    commentsStore,
    activeOutputChannel,
    processMonitorBridge,
    activeCommitDetailsSession,
    onDirtyChange,
    onContentChange,
    onSaveFile,
    onDiscardFile,
    onResolveConflict,
    onOpenMergeEditor,
    onCompleteMerge,
    onOpenTwoWayDiff,
    onSquashSelection,
    onAddSelectionToChat,
    onReplyToThread,
    onSetThreadResolved,
    onOpenThreadLocation,
    onCloseTab,
    onSelectionChange,
    onCopyUnresolvedComments,
    onRefreshComments,
}: EditorWorkspaceProps = $props();

let activeDiffViewerRef = $state<ChatContextSelectionProvider | null>(null);
let activeFileViewerRef = $state<ChatContextSelectionProvider | null>(null);
let activeMultiDiffViewerRef = $state<ChatContextSelectionProvider | null>(null);
let activeMergeViewerRef = $state<ChatContextSelectionProvider | null>(null);

export function resolveActiveChatContextSelection(): EditorChatContextSelection | null {
    if (!activeTab) {
        return null;
    }
    if (activeTab.view.type === 'diff') {
        return activeDiffViewerRef?.getChatContextSelection() ?? null;
    }
    if (activeTab.view.type === 'file') {
        return activeFileViewerRef?.getChatContextSelection() ?? null;
    }
    if (activeTab.view.type === 'multi-diff') {
        return activeMultiDiffViewerRef?.getChatContextSelection() ?? null;
    }
    if (activeTab.view.type === 'merge') {
        return activeMergeViewerRef?.getChatContextSelection() ?? null;
    }
    return null;
}
</script>

<div class="editor-body">
    {#if activeTab && activeTab.view.type === 'diff'}
        {#if activeTab.view.loaded === false}
            <div class="editor-loading-placeholder"></div>
        {:else}
            {#key activeTab.id}
                <PierreDiffViewer
                    bind:this={activeDiffViewerRef}
                    filename={activeTab.title}
                    resourceUri={activeTab.view.rightUri ?? activeTab.view.resourceState?.resourceUri}
                    theme={activeTheme}
                    initialDirty={activeTab.isDirty ?? false}
                    originalContent={activeTab.view.originalContent ?? ''}
                    modifiedContent={activeTab.view.modifiedContent ?? ''}
                    fileStatus={activeTab.view.resourceState?.status}
                    isWorkingCopy={activeTab.view.rightUri?.scheme === 'file' ||
                        activeTab.view.rightUri?.scheme === 'jj-edit' ||
                        (activeTab.view.resourceState
                            ? isWorkingCopyRevision(
                                  activeTab.view.resourceState.revision,
                                  currentSnapshot?.currentEntry?.change_id,
                              )
                            : false)}
                    isConflict={activeTab.view.resourceState?.status === 'conflicted' ||
                        (activeTab.view.resourceState?.contextValue?.toLowerCase().includes('allowopenmergeeditor') ?? false)}
                    parentMutable={currentSnapshot?.parentMutable ?? false}
                    commentThreads={activeDiffThreads}
                    onReplyToThread={onReplyToThread}
                    onSetThreadResolved={onSetThreadResolved}
                    onSave={onSaveFile}
                    onDiscard={onDiscardFile}
                    onResolveConflict={onResolveConflict}
                    onOpenMergeEditor={() => {
                        if (activeTab?.view.type === 'diff' && activeTab.view.resourceState) {
                            onOpenMergeEditor(activeTab.view.resourceState);
                        }
                    }}
                    onDirtyChange={onDirtyChange}
                    onContentChange={onContentChange}
                    onSelectionChange={onSelectionChange}
                    onSquashSelection={onSquashSelection}
                    onAddSelectionToChat={() => onAddSelectionToChat()}
                />
            {/key}
        {/if}
    {:else if activeTab && activeTab.view.type === 'merge'}
        {#if activeTab.view.loaded === false}
            <div class="editor-loading-placeholder"></div>
        {:else}
            {#key activeTab.id}
                <MergeEditorView
                    bind:this={activeMergeViewerRef}
                    filePath={activeTab.view.resourceState?.relativePath || activeTab.view.uri.fsPath || activeTab.title}
                    baseContent={activeTab.view.baseContent}
                    leftContent={activeTab.view.leftContent}
                    rightContent={activeTab.view.rightContent}
                    onCompleteMerge={onCompleteMerge}
                    onSave={onSaveFile}
                    onDirtyChange={onDirtyChange}
                    onContentChange={onContentChange}
                    onOpenTwoWayDiff={() => {
                        if (activeTab?.view.type === 'merge' && activeTab.view.resourceState) {
                            onOpenTwoWayDiff(activeTab.view.resourceState);
                        }
                    }}
                    onAddSelectionToChat={() => onAddSelectionToChat()}
                />
            {/key}
        {/if}
    {:else if activeTab && activeTab.view.type === 'multi-diff'}
        {#key activeTab.id}
            <PierreMultiDiffViewer
                bind:this={activeMultiDiffViewerRef}
                title={activeTab.title}
                files={activeTab.view.files}
                theme={activeTheme}
                commentThreads={activeMultiDiffThreads}
                onReplyToThread={onReplyToThread}
                onSetThreadResolved={onSetThreadResolved}
                onAddSelectionToChat={() => onAddSelectionToChat()}
            />
        {/key}
    {:else if activeTab && activeTab.view.type === 'file'}
        {#key activeTab.id}
            <PierreFileViewer
                bind:this={activeFileViewerRef}
                filename={activeTab.title}
                resourceUri={activeTab.view.uri}
                content={activeTab.view.content ?? ''}
                theme={activeTheme}
                initialDirty={activeTab.isDirty ?? false}
                isWorkingCopy={activeTab.view.uri.scheme === 'file' || activeTab.view.uri.scheme === 'jj-edit'}
                onSave={onSaveFile}
                onDiscard={onDiscardFile}
                onDirtyChange={onDirtyChange}
                onContentChange={onContentChange}
                onSelectionChange={onSelectionChange}
                onAddSelectionToChat={() => onAddSelectionToChat()}
            />
        {/key}
    {:else if activeTab && activeTab.view.type === 'commit-details' && activeCommitDetailsSession}
        {#key activeTab.id}
            {@const sessionTabId = activeTab.id}
            <CommitDetailsView
                transport={activeCommitDetailsSession.bridge.transport}
                onClose={() => onCloseTab(sessionTabId)}
            />
        {/key}
    {:else if activeTab && activeTab.view.type === 'comments' && commentsStore}
        <CommentsPane
            store={commentsStore}
            onOpenThread={onOpenThreadLocation}
            onReply={onReplyToThread}
            onSetResolved={onSetThreadResolved}
            onCopyUnresolved={onCopyUnresolvedComments}
            onRefresh={onRefreshComments}
            onClose={() => onCloseTab(COMMENTS_TAB_ID)}
        />
    {:else if activeTab && activeTab.view.type === 'output'}
        <OutputPane
            channel={activeOutputChannel}
            onClose={() => onCloseTab(OUTPUT_TAB_ID)}
        />
    {:else if activeTab && activeTab.view.type === 'process-monitor'}
        <ProcessMonitorView
            transport={processMonitorBridge.transport}
            onClose={() => onCloseTab(PROCESS_MONITOR_TAB_ID)}
        />
    {:else}
        <div class="empty-editor-message">
            <i class="codicon codicon-source-control large-icon" aria-hidden="true"></i>
            <h2>Source Control (JJ View)</h2>
            <p>Select a changed file in the left pane to view diffs and make edits, or select a commit in the log.</p>
        </div>
    {/if}
</div>

<style>
.editor-body {
    flex: 1;
    min-height: 0;
    width: 100%;
    position: relative;
    overflow: hidden;
}

.editor-loading-placeholder {
    width: 100%;
    height: 100%;
    background-color: var(--vscode-editor-background);
}

.empty-editor-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    user-select: none;
}

.empty-editor-message h2 {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
    color: var(--vscode-foreground);
}

.empty-editor-message p {
    font-size: 13px;
    margin: 0;
    max-width: 360px;
    line-height: 1.5;
}

.large-icon {
    font-size: 48px;
    color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground));
    margin-bottom: 8px;
}
</style>
