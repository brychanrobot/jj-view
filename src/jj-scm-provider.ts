/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from './jj-service';
import { JjStatusEntry } from './jj-types';
import { ChangeDetectionManager } from './change-detection-manager';

import * as fs from 'fs/promises';
import * as path from 'path';

import { JjDocumentContentProvider } from './jj-content-provider';
import { JjMergeContentProvider } from './jj-merge-provider';
import { JjDecorationProvider } from './jj-decoration-provider';
import { JjContextKey } from './jj-context-keys';
import { completeSquashCommand } from './commands/squash';
import { getErrorMessage } from './commands/command-utils';
import { RefreshScheduler } from './refresh-scheduler';
import { createDiffUris } from './uri-utils';

export interface JjResourceState extends vscode.SourceControlResourceState {
    revision: string;
}

export class JjScmProvider implements vscode.Disposable {
    private _disposed = false;
    private disposables: vscode.Disposable[] = [];
    private _sourceControl: vscode.SourceControl;
    private _workingCopyGroup: vscode.SourceControlResourceGroup;
    private _parentGroups: vscode.SourceControlResourceGroup[] = [];
    private _conflictGroup: vscode.SourceControlResourceGroup;
    private _lastKnownDescription: string = '';
    private _lastKnownCommitId: string = '';
    private _selectedCommitIds: string[] = [];

    private _onDidChangeStatus = new vscode.EventEmitter<void>();
    readonly onDidChangeStatus: vscode.Event<void> = this._onDidChangeStatus.event;

    private _onRepoStateReady = new vscode.EventEmitter<void>();
    readonly onRepoStateReady: vscode.Event<void> = this._onRepoStateReady.event;

    private _refreshScheduler: RefreshScheduler;
    private _fileWatcher: ChangeDetectionManager;
    public decorationProvider: JjDecorationProvider;

    constructor(
        _context: vscode.ExtensionContext,
        private jj: JjService,
        workspaceRoot: string,
        public readonly outputChannel: vscode.OutputChannel,
        public readonly contentProvider?: JjDocumentContentProvider,
    ) {
        this._sourceControl = vscode.scm.createSourceControl('jj', 'Jujutsu', vscode.Uri.file(workspaceRoot));
        this.decorationProvider = new JjDecorationProvider();
        this._refreshScheduler = new RefreshScheduler((options) => this.refresh(options));

        // Create groups in order of display
        this._conflictGroup = this._sourceControl.createResourceGroup('conflicts', 'Merge Conflicts');
        this._workingCopyGroup = this._sourceControl.createResourceGroup('working-copy', 'Working Copy');
        // Parent groups are created dynamically in refresh()

        this._sourceControl.quickDiffProvider = this;
        this._sourceControl.inputBox.placeholder = 'Describe your changes...';
        this._sourceControl.acceptInputCommand = { command: 'jj-view.commit', title: 'Commit (Ctrl+Enter)' };

        this.disposables.push(this._sourceControl);
        this.disposables.push(this._conflictGroup);
        this.disposables.push(this._workingCopyGroup);
        this.disposables.push(this.decorationProvider);
        this.disposables.push(this._refreshScheduler);

        const mergeProvider = new JjMergeContentProvider(this.jj);
        this.disposables.push(vscode.workspace.registerTextDocumentContentProvider('jj-merge-output', mergeProvider));

        // Handle saving of virtual merge output
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(async (doc) => {
                if (doc.uri.scheme === 'jj-merge-output') {
                    // ... (existing merge logic)
                    const query = new URLSearchParams(doc.uri.query);
                    const fsPath = query.get('path');
                    if (fsPath) {
                        try {
                            await fs.writeFile(fsPath, doc.getText());
                        } catch (e) {
                            vscode.window.showErrorMessage(`Failed to save merge result: ${e}`);
                        }
                    }
                }
            }),
        );

        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(async (doc) => {
                const basename = path.basename(doc.uri.fsPath);
                if (basename === 'SQUASH_MSG') {
                    const metaPath = path.join(this.jj.workspaceRoot, '.jj', 'vscode', 'SQUASH_META.json');
                    const msgPath = path.join(this.jj.workspaceRoot, '.jj', 'vscode', 'SQUASH_MSG');

                    // Check if pending squash exists
                    try {
                        await fs.access(metaPath);
                        // Prompt user
                        const choice = await vscode.window.showInformationMessage(
                            'Pending squash description detected. Do you want to complete the squash?',
                            { modal: true },
                            'Complete Squash',
                            'Abort',
                        );

                        if (choice === 'Complete Squash') {
                            await completeSquashCommand(this, this.jj);
                        } else if (choice === 'Abort') {
                            // Cleanup
                            await fs.unlink(metaPath).catch(() => {});
                            await fs.unlink(msgPath).catch(() => {});
                        }
                    } catch {
                        // No pending squash, ignore
                    }
                }
            }),
        );

        // Initialize file watcher
        this._fileWatcher = new ChangeDetectionManager(
            workspaceRoot, 
            this.jj, 
            this.outputChannel,
            async (options) => {
                await this._refreshScheduler.trigger(options);
            }
        );
        this.disposables.push(this._fileWatcher);

        // Initial refresh
        this.refresh({ forceSnapshot: true });
    }

    private _refreshMutex: Promise<void> = Promise.resolve();

    async refresh(options: { forceSnapshot?: boolean; reason?: string } = {}): Promise<void> {
        // Chain the refresh execution to ensure serial execution
        this._refreshMutex = this._refreshMutex.then(async () => {
            if (this._disposed) {
                return;
            }
            const { forceSnapshot, reason } = options;
            const reasonStr = reason ? ` (reason: ${reason})` : '';
            this.outputChannel.appendLine(`Refreshing JJ SCM (snapshot: ${!!forceSnapshot})${reasonStr}...`);
            const start = performance.now();
            try {
                // 0. Force a snapshot if requested
                if (forceSnapshot) {
                    await this.jj.status();
                }
                this._onRepoStateReady.fire();

                // Invalidate diff content cache so stale content is never served
                this.contentProvider?.invalidateCache();

                // 1. Fetch data in parallel for performance
                const [logResult, children, conflictedPaths] = await Promise.all([
                    this.jj.getLog({ revision: '@' }),
                    this.jj.getChildren('@'),
                    this.jj.getConflictedFiles(),
                ]);
                const [logEntry] = logResult;
                const currentEntry = logEntry;

                let parentMutable = false;
                const hasChild = children.length > 0;

                if (currentEntry) {
                    const parents = currentEntry.parents;

                    if (parents && parents.length > 0) {
                        // Normalize parent to string if needed
                        let parentRev = parents[0];
                        if (typeof parentRev === 'object' && parentRev !== null && 'commit_id' in parentRev) {
                            parentRev = (parentRev as { commit_id: string }).commit_id;
                        }
                        // Check parent mutability
                        // Try to use "parents_immutable" from the current entry if available.
                        if (currentEntry.parents_immutable && currentEntry.parents_immutable.length > 0) {
                            parentMutable = !currentEntry.parents_immutable[0];
                        } else {
                            // Fallback: Fetch parent log to check mutability
                            this.outputChannel.appendLine(`Checking parent mutability for: ${parentRev}`);
                            const [parentLog] = await this.jj.getLog({
                                revision: parentRev as string,
                            });
                            parentMutable = !parentLog.is_immutable;
                        }
                    }
                }

                if (currentEntry) {
                    const desc = currentEntry.description ? currentEntry.description.trim() : '';
                    const commitId = currentEntry.change_id;

                    // Update input box if:
                    // 1. It's empty
                    // 2. We switched to a different commit (context switch)
                    // 3. The value matches what we last populated (no user edits)
                    if (
                        this._sourceControl.inputBox.value === '' ||
                        this._lastKnownCommitId !== commitId ||
                        this._sourceControl.inputBox.value === this._lastKnownDescription
                    ) {
                        this._sourceControl.inputBox.value = desc;
                        this._lastKnownDescription = desc;
                        this._lastKnownCommitId = commitId;
                    }
                }

                await vscode.commands.executeCommand('setContext', JjContextKey.ParentMutable, parentMutable);
                await vscode.commands.executeCommand('setContext', JjContextKey.HasChild, hasChild);

                // 2. Update Resource Groups & Collect Decorations
                const decorationMap = new Map<string, JjStatusEntry>();
                // const root = this._sourceControl.rootUri?.fsPath || '';

                // Working Copy Changes
                const changes = currentEntry?.changes || [];
                this._workingCopyGroup.resourceStates = changes.map((c) => {
                    const state = this.toResourceState(c, '@');
                    decorationMap.set(state.resourceUri.toString(), c);
                    return state;
                });

                // 3. Update Conflict Group (conflictedPaths fetched above)
                this._conflictGroup.resourceStates = conflictedPaths.map((path) => {
                    const entry: JjStatusEntry = { path, status: 'modified', conflicted: true };
                    const state = this.toResourceState(entry, '@');
                    decorationMap.set(state.resourceUri.toString(), entry);
                    return state;
                });
                this._conflictGroup.hideWhenEmpty = true;

                // 4. Update Parent Groups (one for each parent)
                const neededParentCount = currentEntry?.parents?.length || 0;

                // Dispose excess parent groups
                while (this._parentGroups.length > neededParentCount) {
                    const group = this._parentGroups.pop();
                    group?.dispose();
                }

                // Fetch all parent entries in parallel
                if (currentEntry && currentEntry.parents && currentEntry.parents.length > 0) {
                    const parentRefs = currentEntry.parents.map((parentRef) => {
                        if (typeof parentRef === 'object' && parentRef !== null && 'commit_id' in parentRef) {
                            return (parentRef as { commit_id: string }).commit_id;
                        }
                        return parentRef as string;
                    });

                    const parentEntries = await Promise.all(
                        parentRefs.map((ref) => this.jj.getLog({ revision: ref })),
                    );

                    // Process fetched parent entries
                    for (let i = 0; i < parentEntries.length; i++) {
                        const [parentEntry] = parentEntries[i];
                        const parentRef = parentRefs[i];

                        if (parentEntry) {
                            const shortId = parentEntry.change_id_shortest || parentEntry.change_id.substring(0, 8);
                            const desc = parentEntry.description?.trim() || '(no description)';

                            const label =
                                currentEntry.parents.length > 1
                                    ? `Parent ${i + 1}: ${shortId} - ${desc}`
                                    : `Parent: ${shortId} - ${desc}`;

                            // Reuse existing group or create new one
                            let group: vscode.SourceControlResourceGroup;
                            const contextValue = parentEntry.is_immutable ? 'jjParentGroup' : 'jjParentGroup:mutable';

                            if (i < this._parentGroups.length) {
                                group = this._parentGroups[i];
                                group.label = label;
                                group.contextValue = contextValue;
                            } else {
                                const groupId = `parent-${i}`;
                                group = this._sourceControl.createResourceGroup(groupId, label);
                                group.hideWhenEmpty = true;
                                group.contextValue = contextValue;
                                this._parentGroups.push(group);
                            }

                            const parentChanges = parentEntry.changes || [];
                            group.resourceStates = parentChanges.map((c) => {
                                const state = this.toResourceState(c, parentRef);
                                decorationMap.set(state.resourceUri.toString(), c);
                                return state;
                            });
                        }
                    }
                }

                // Update Decoration Provider
                this.decorationProvider.setDecorations(decorationMap);

                // Update SCM Count - Only count Working Copy changes
                // VS Code sums all groups by default if count is not set, so we must set it explicitly.
                this._sourceControl.count = this._workingCopyGroup.resourceStates.length;
            } catch (e: unknown) {
                const err = e as { message?: string };
                if (
                    err.message &&
                    ((err.message.includes('Object') && err.message.includes('not found')) ||
                        err.message.includes('No such file or directory'))
                ) {
                    this.outputChannel.appendLine(`Ignored transient error during refresh: ${getErrorMessage(e)}`);
                } else {
                    this.outputChannel.appendLine(`Error refreshing JJ SCM: ${getErrorMessage(e)}`);
                    console.error('Error refreshing JJ SCM:', e);
                }
            } finally {
                if (!this._disposed) {
                    const duration = performance.now() - start;
                    try {
                        this.outputChannel.appendLine(`JJ SCM refresh took ${duration.toFixed(0)}ms`);
                    } catch {
                        // Ignore channel closed errors
                    }
                    this._onDidChangeStatus.fire();
                }
            }
        });

        return this._refreshMutex;
    }

    async abandon(revisions: string[]) {
        if (revisions.length === 0) return;
        await this.jj.abandon(revisions);
        await this.refresh();
    }

    async restore(resourceStates: vscode.SourceControlResourceState[]) {
        const paths = resourceStates.map((r) => r.resourceUri.fsPath);
        await this.jj.restore(paths);
        await this.refresh();
    }

    async setDescription(message: string) {
        await this.jj.describe(message);
        await this.refresh();
    }

    async handleSelectionChange(commitIds: string[]) {
        this._selectedCommitIds = commitIds;
    }

    getSelectedCommitIds(): string[] {
        return this._selectedCommitIds;
    }

    async openMergeEditor(resourceStates: vscode.SourceControlResourceState[]) {
        if (resourceStates.length === 0) {
            return;
        }
        const r = resourceStates[0];
        const uri = r.resourceUri;
        // const relativePath = vscode.workspace.asRelativePath(uri);

        try {
            const encodedPath = encodeURIComponent(uri.fsPath);

            // Create virtual URIs for each part - use relative path so VS Code doesn't try to read root
            const relativePath = vscode.workspace.asRelativePath(uri);
            const virtualPath = path.posix.join('/', relativePath); // Ensure specific path format

            const baseUri = uri.with({
                scheme: 'jj-merge-output',
                authority: 'jj-merge',
                path: virtualPath,
                query: `path=${encodedPath}&part=base`,
            });
            const leftUri = uri.with({
                scheme: 'jj-merge-output',
                authority: 'jj-merge',
                path: virtualPath,
                query: `path=${encodedPath}&part=left`,
            });
            const rightUri = uri.with({
                scheme: 'jj-merge-output',
                authority: 'jj-merge',
                path: virtualPath,
                query: `path=${encodedPath}&part=right`,
            });
            // Output is the real file
            const outputUri = uri;
            const args = {
                base: baseUri, // base is a plain URI, not an object
                input1: { uri: leftUri, title: 'Side 1' },
                input2: { uri: rightUri, title: 'Side 2' },
                output: outputUri,
            };
            await vscode.commands.executeCommand('_open.mergeEditor', args);
        } catch (e) {
            console.error('Failed to open merge editor:', e);
            vscode.window.showErrorMessage(`Failed to open merge editor: ${e}`);
            await vscode.commands.executeCommand('vscode.open', uri);
        }
    }

    private toResourceState(entry: JjStatusEntry, revision: string = '@'): JjResourceState {
        const root = this._sourceControl.rootUri?.fsPath || '';
        const { leftUri, rightUri, resourceUri } = createDiffUris(entry, revision, root);

        const command: vscode.Command = entry.conflicted
            ? {
                  command: 'jj-view.openMergeEditor',
                  title: 'Open 3-Way Merge',
                  arguments: [{ resourceUri }],
              }
            : {
                  command: 'vscode.diff',
                  title: 'Diff',
                  arguments: [leftUri, rightUri, `${entry.path} (${revision === '@' ? 'Working Copy' : revision})`],
              };

        return {
            resourceUri,
            command: command,
            decorations: {
                tooltip: entry.conflicted ? 'Conflicted' : entry.status,
                faded: false,
                strikeThrough: entry.status === 'removed',
            },
            contextValue: entry.conflicted ? 'jjConflict' : revision === '@' ? 'jjWorkingCopy' : 'jjParent',
            revision: revision,
        };
    }

    provideOriginalResource(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
        return uri.with({ scheme: 'jj-view', query: 'base=@&side=left' });
    }

    get sourceControl(): vscode.SourceControl {
        return this._sourceControl;
    }

    dispose() {
        this._disposed = true;
        this.disposables.forEach((d) => d.dispose());
    }
}
