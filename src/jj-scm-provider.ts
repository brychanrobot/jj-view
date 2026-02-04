// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as vscode from 'vscode';
import { JjService } from './jj-service';
import { JjStatusEntry } from './jj-types';

import * as fs from 'fs/promises';
import * as path from 'path';

import { JjDocumentContentProvider } from './jj-content-provider';
import { JjMergeContentProvider } from './jj-merge-provider';
import { JjDecorationProvider } from './jj-decoration-provider';
import { JjContextKey } from './jj-context-keys';
import { completeSquashCommand } from './commands/squash';
import { getErrorMessage } from './commands/command-utils';
import { RefreshScheduler } from './refresh-scheduler';

export interface JjResourceState extends vscode.SourceControlResourceState {
    revision: string;
}

export class JjScmProvider implements vscode.Disposable {
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

    private _refreshScheduler: RefreshScheduler;
    public decorationProvider: JjDecorationProvider;

    constructor(
        _context: vscode.ExtensionContext,
        private jj: JjService,
        workspaceRoot: string,
        private outputChannel: vscode.OutputChannel,
        public readonly contentProvider?: JjDocumentContentProvider,
    ) {
        this._sourceControl = vscode.scm.createSourceControl('jj', 'Jujutsu', vscode.Uri.file(workspaceRoot));
        this.decorationProvider = new JjDecorationProvider();
        this._refreshScheduler = new RefreshScheduler(() => this.refresh());

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

        // Note: Generic commands are registered in extension.ts. Context menu commands requiring specific arguments are handled here.

        // Watch for file changes to trigger refresh
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        const changeHandler = (uri: vscode.Uri) => {
            if (this.shouldIgnoreEvent(uri)) {
                return;
            }
            this.outputChannel.appendLine(`File change triggering refresh: ${uri.fsPath}`);
            this._refreshScheduler.trigger();
        };

        this.disposables.push(watcher.onDidChange(changeHandler));
        this.disposables.push(watcher.onDidCreate(changeHandler));
        this.disposables.push(watcher.onDidDelete(changeHandler));
        this.disposables.push(watcher);

        // Initial refresh
        this.refresh();
    }

    private shouldIgnoreEvent(uri: vscode.Uri): boolean {
        const pathStr = uri.fsPath;
        const config = vscode.workspace.getConfiguration('jj-view');
        const ignoredSegments = config.get<string[]>('watcherIgnore', ['node_modules', '.git']);

        // Check compatibility with Windows/Linux paths
        const parts = pathStr.split(path.sep);

        // Check if any part of the path is in the ignored list
        if (parts.some((p) => ignoredSegments.includes(p))) {
            return true;
        }

        // Also ignore specific files
        if (path.basename(pathStr) === '.DS_Store') {
            return true;
        }

        // Ignore lock, tree_state, and temp files in .jj directory to prevent refresh loops
        const relativePath = path.relative(this.jj.workspaceRoot, pathStr);
        if (relativePath.split(path.sep)[0] === '.jj') {
            if (pathStr.endsWith('.lock') || pathStr.endsWith('tree_state')) {
                return true;
            }
            const filename = path.basename(pathStr);
            if (filename.startsWith('#') || filename.startsWith('.tmp')) {
                return true;
            }
        }

        return false;
    }

    private _refreshMutex: Promise<void> = Promise.resolve();

    async refresh(): Promise<void> {
        // Chain the refresh execution to ensure serial execution
        this._refreshMutex = this._refreshMutex.then(async () => {
            this.outputChannel.appendLine('Refreshing JJ SCM...');
            try {
                // 0. Force a snapshot first
                await this.jj.status();

                // 1. Calculate Context Keys & Get Log with Changes
                const [logEntry] = await this.jj.getLog({ revision: '@', useCachedSnapshot: true });
                // alias for clarity and scope access
                const currentEntry = logEntry;

                let parentMutable = false;
                let hasChild = false;

                if (currentEntry) {
                    const parents = currentEntry.parents;
                    this.outputChannel.appendLine(
                        `Current log entry: ${currentEntry.change_id}, parents: ${JSON.stringify(parents)}`,
                    );

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
                                useCachedSnapshot: true,
                            });
                            parentMutable = !parentLog.is_immutable;
                        }
                    }

                    // Check for children
                    const children = await this.jj.getChildren('@', /*useCachedSnapshot=*/ true);
                    this.outputChannel.appendLine(`Children count: ${children.length}`);
                    hasChild = children.length > 0;
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

                this.outputChannel.appendLine(`Setting context jj.parentMutable to ${parentMutable}`);
                await vscode.commands.executeCommand('setContext', JjContextKey.ParentMutable, parentMutable);

                this.outputChannel.appendLine(`Setting context jj.hasChild to ${hasChild}`);
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

                // 3. Update Conflict Group
                const conflictedPaths = await this.jj.getConflictedFiles(/*useCachedSnapshot=*/ true);
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

                // Update or create parent groups
                if (currentEntry && currentEntry.parents && currentEntry.parents.length > 0) {
                    for (let i = 0; i < currentEntry.parents.length; i++) {
                        let parentRef = currentEntry.parents[i];

                        // Normalize parent object to commit_id
                        if (typeof parentRef === 'object' && parentRef !== null && 'commit_id' in parentRef) {
                            parentRef = (parentRef as { commit_id: string }).commit_id;
                        }

                        // Fetch parent log entry for description and file changes (parent list only provides IDs)
                        const [parentEntry] = await this.jj.getLog({
                            revision: parentRef as string,
                            useCachedSnapshot: true,
                        });

                        if (parentEntry) {
                            const shortId = parentEntry.change_id.substring(0, 8);
                            const desc = parentEntry.description?.trim() || '(no description)';
                            const shortDesc = desc.split('\n')[0].substring(0, 40);

                            const label =
                                currentEntry.parents.length > 1
                                    ? `Parent ${i + 1}: ${shortId} - ${shortDesc}`
                                    : `Parent: ${shortId} - ${shortDesc}`;

                            // Reuse existing group or create new one
                            let group: vscode.SourceControlResourceGroup;
                            if (i < this._parentGroups.length) {
                                group = this._parentGroups[i];
                                group.label = label;
                            } else {
                                const groupId = `parent-${i}`;
                                group = this._sourceControl.createResourceGroup(groupId, label);
                                group.hideWhenEmpty = true;
                                group.contextValue = parentEntry.is_immutable
                                    ? 'jjParentGroup'
                                    : 'jjParentGroup:mutable';
                                this._parentGroups.push(group);
                            }

                            const parentChanges = parentEntry.changes || [];
                            group.resourceStates = parentChanges.map((c) => {
                                const state = this.toResourceState(c, parentRef as string);
                                // Now we add to decorationMap. The URI query ensures uniqueness.
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
                    this.outputChannel.appendLine(`Failed to refresh JJ SCM: ${getErrorMessage(e)}`);
                    console.error('Failed to refresh JJ SCM:', e);
                }
            } finally {
                this._onDidChangeStatus.fire();
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
        let absoluteUri = vscode.Uri.joinPath(vscode.Uri.file(root), entry.path);

        // If not working copy, add query to make URI unique for DecorationProvider
        // This ensures SCM view gets decorations for parents, but Explorer (which uses file uri) does not get confused.
        if (revision !== '@') {
            absoluteUri = absoluteUri.with({ query: `jj-revision=${revision}` });
        }

        // left: revision - 1 (parent of revision)
        // right: revision
        let leftPath = absoluteUri.path;
        if ((entry.status === 'renamed' || entry.status === 'copied') && entry.oldPath) {
            leftPath = vscode.Uri.joinPath(vscode.Uri.file(root), entry.oldPath).path;
        }

        const leftUri = vscode.Uri.from({
            scheme: 'jj-view',
            path: leftPath,
            query: `revision=${revision}-&path=${encodeURIComponent(leftPath)}`,
        });

        const rightUri =
            revision === '@'
                ? absoluteUri
                : vscode.Uri.from({
                      scheme: 'jj-view',
                      path: absoluteUri.path,
                      query: `revision=${revision}`,
                  });

        const command: vscode.Command = entry.conflicted
            ? {
                  command: 'jj-view.openMergeEditor',
                  title: 'Open 3-Way Merge',
                  arguments: [{ resourceUri: absoluteUri }], // Pass single object matching ResourceState
              }
            : {
                  command: 'vscode.diff',
                  title: 'Diff',
                  arguments: [leftUri, rightUri, `${entry.path} (${revision === '@' ? 'Working Copy' : revision})`],
              };

        // Note: We populate SourceControlResourceDescorations too, but badges (letters) come from FileDecorationProvider
        return {
            resourceUri: absoluteUri,
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
        return uri.with({ scheme: 'jj-view', query: 'revision=@-' });
    }

    get sourceControl(): vscode.SourceControl {
        return this._sourceControl;
    }

    dispose() {
        this.disposables.forEach((d) => d.dispose());
    }
}
