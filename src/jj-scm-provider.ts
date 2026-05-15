/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangeDetectionManager } from './change-detection-manager';
import { getErrorMessage } from './commands/command-utils';
import { completeSquashRevisionCommand, isSquashInProgress } from './commands/squash-revision';
import { JjContextKey, ScmContextValue } from './jj-context-keys';
import { JjDecorationProvider } from './jj-decoration-provider';
import type { JjEditFileSystemProvider } from './jj-edit-fs-provider';
import { JjMergeContentProvider } from './jj-merge-provider';
import { JjService } from './jj-service';
import type { JjLogEntry, JjStatusEntry } from './jj-types';
import type { JjViewFileSystemProvider } from './jj-view-fs-provider';
import { RefreshScheduler } from './refresh-scheduler';
import { createDiffUris } from './uri-utils';
import { formatDisplayChangeId } from './utils/jj-utils';

export interface JjResourceState extends vscode.SourceControlResourceState {
    revision: string;
    /** The URIs used for generating diffs. */
    leftUri?: vscode.Uri;
    rightUri?: vscode.Uri;
    diffTitle?: string;
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
    private _currentEntry: JjLogEntry | undefined;
    private _workingCopyStatuses = new Map<string, JjStatusEntry>();

    private _onDidChangeStatus = new vscode.EventEmitter<void>();
    readonly onDidChangeStatus: vscode.Event<void> = this._onDidChangeStatus.event;

    private _onRepoStateReady = new vscode.EventEmitter<void>();
    readonly onRepoStateReady: vscode.Event<void> = this._onRepoStateReady.event;

    private _refreshScheduler: RefreshScheduler;
    private _fileWatcher: ChangeDetectionManager;
    public decorationProvider: JjDecorationProvider;

    constructor(
        public readonly context: vscode.ExtensionContext,
        public readonly jj: JjService,
        workspaceRoot: string,
        public readonly outputChannel: vscode.OutputChannel,
        public readonly viewFileSystemProvider?: JjViewFileSystemProvider,
        public readonly editProvider?: JjEditFileSystemProvider,
    ) {
        this._sourceControl = vscode.scm.createSourceControl('jj', 'Jujutsu', vscode.Uri.file(workspaceRoot));
        this.decorationProvider = new JjDecorationProvider(this.jj, workspaceRoot);
        this._refreshScheduler = new RefreshScheduler((options) => this.refresh(options));

        // Create groups in order of display
        this._conflictGroup = this._sourceControl.createResourceGroup(ScmContextValue.ConflictGroup, 'Merge Conflicts');
        this._workingCopyGroup = this._sourceControl.createResourceGroup(
            ScmContextValue.WorkingCopyGroup,
            'Working Copy',
        );
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

        // Finalize squash when the SQUASH_MSG tab is closed.
        //
        // RATIONALE: We use onDidChangeTabs rather than onDidCloseTextDocument because:
        // 1. TextDocument disposal is often delayed by VS Code's internal cache, whereas
        //    tab closure is an immediate UI signal that matches terminal "editor exit".
        // 2. By accessing doc.getText() at the moment of closure, we avoid a race condition
        //    where jj might read the file from disk before VS Code has finished an async save.
        // 3. We check doc.isDirty to respect the user's "Don't Save" choice. If it's still
        //    dirty on close, we revert to the original disk content.
        this.disposables.push(
            vscode.window.tabGroups.onDidChangeTabs(async (e) => {
                for (const tab of e.closed) {
                    if (
                        tab.input instanceof vscode.TabInputText &&
                        path.basename(tab.input.uri.fsPath) === 'SQUASH_MSG'
                    ) {
                        const msgUri = tab.input.uri;

                        const storageDir = this.getSquashStorageDir();
                        const metaPath = path.join(storageDir, 'SQUASH_META.json');

                        try {
                            await fs.access(metaPath);
                            if (isSquashInProgress(this)) {
                                return;
                            }

                            // If the document is not dirty, it was either saved or never changed.
                            // If it IS dirty, the user chose "Don't Save", so we read the original from disk.
                            const doc = vscode.workspace.textDocuments.find(
                                (d) => d.uri.toString() === msgUri.toString(),
                            );
                            const message =
                                doc && !doc.isDirty ? doc.getText() : await fs.readFile(msgUri.fsPath, 'utf-8');

                            await completeSquashRevisionCommand(this, this.jj, message);
                        } catch {
                            // No pending squash, ignore
                        }
                    }
                }
            }),
        );

        // Initialize file watcher
        this._fileWatcher = new ChangeDetectionManager(workspaceRoot, this.jj, this.outputChannel, async (options) => {
            await this._refreshScheduler.trigger(options);
        });
        this.disposables.push(this._fileWatcher);

        // Initial refresh
        this.refresh({ forceSnapshot: true, reason: 'initialization' });
    }

    /**
     * Returns the directory used to store temporary state for deferred squash operations.
     * Uses VS Code's storageUri if available, otherwise falls back to a temporary directory.
     */
    public getSquashStorageDir(): string {
        if (this.context.storageUri) {
            return this.context.storageUri.fsPath;
        }
        // Fallback to OS temp dir if no workspace storage is available
        const hash = crypto.createHash('md5').update(this.jj.workspaceRoot).digest('hex');
        return path.join(os.tmpdir(), `jj-view-squash-${hash}`);
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
            const msg = `Refreshing JJ Scm (snapshot: ${!!forceSnapshot})${reasonStr}...`;
            this.outputChannel.appendLine(msg);
            console.log(`[Extension Host] ${msg}`);
            const start = performance.now();
            try {
                // Clear any cached data that might be stale after external changes
                await this.jj.clearCache();

                // 0. Force a snapshot if requested
                if (forceSnapshot) {
                    await this.jj.status();
                }
                await this.jj.getRepoRoot(); // Pre-warm the repo root cache
                this._onRepoStateReady.fire();

                // 1. Fetch data in parallel for performance
                const config = vscode.workspace.getConfiguration('jj-view');
                const maxMutableAncestors = config.get<number>('maxMutableAncestors', 10);
                const openDiffOnClick = config.get<boolean>('openDiffOnClick', true);
                const limit = maxMutableAncestors + 1;

                // Chain getLog directly off getLogIds so it runs concurrently with getChildren and getConflictedFiles
                const bulkLogPromise = this.jj
                    .getLogIds({ revision: `(::@ & mutable()) | parents(roots(::@ & mutable()))`, limit })
                    .then((commitIds) => Promise.all(commitIds.map((id) => this.jj.getLog({ revision: id }))));

                const [bulkLogEntries, children, conflictedPaths] = await Promise.all([
                    bulkLogPromise,
                    this.jj.getChildren('@'),
                    this.jj.getConflictedFiles(),
                ]);

                const bulkLog = bulkLogEntries.map((entries) => entries[0]).filter(Boolean);

                // Extract current entry from bulk log (it should be the first one with is_current_working_copy or just the first entry)
                const currentEntry = bulkLog.find((e) => e.is_current_working_copy) || bulkLog[0];
                this._currentEntry = currentEntry;
                const bulkLogMap = new Map<string, JjLogEntry>(bulkLog.map((entry) => [entry.commit_id, entry]));

                let parentMutable = false;
                const hasChild = children.length > 0;

                if (currentEntry) {
                    const parentRefs = currentEntry.parents;

                    if (parentRefs && parentRefs.length > 0) {
                        const firstParent = parentRefs[0];
                        parentMutable = !firstParent.is_immutable;
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

                // 2. Find Mutable Ancestors (traverse graph)
                let currentFocus = currentEntry;
                let ancestorDepth = 1;
                const ancestorsToDisplay: {
                    entry: JjLogEntry;
                    prefix: string;
                    isMutable: boolean;
                    canSquash: boolean;
                }[] = [];

                if (currentFocus) {
                    while (currentFocus && ancestorsToDisplay.length < maxMutableAncestors) {
                        if (!currentFocus.parents || currentFocus.parents.length === 0) {
                            break;
                        }

                        // For the prefix, we use @-1, @-2. For merge parents, @-1^1, @-1^2 etc.
                        const isMerge = currentFocus.parents.length > 1;

                        // Get all parent entries from the bulk map
                        const parentEntries = currentFocus.parents.map((parent) => {
                            return bulkLogMap.get(parent.commit_id);
                        });

                        for (let i = 0; i < parentEntries.length; i++) {
                            const parentEntry = parentEntries[i];
                            if (!parentEntry || parentEntry.is_immutable) {
                                continue;
                            }

                            const prefix = isMerge ? `@-${ancestorDepth}^${i + 1}` : `@-${ancestorDepth}`;

                            const canSquash =
                                !parentEntry.is_immutable &&
                                parentEntry.parents !== undefined &&
                                parentEntry.parents.length > 0 &&
                                !parentEntry.parents[0].is_immutable;

                            ancestorsToDisplay.push({
                                entry: parentEntry,
                                prefix,
                                isMutable: !parentEntry.is_immutable,
                                canSquash,
                            });
                        }

                        // Stop traversing if it's a merge commit
                        if (isMerge) {
                            break;
                        }

                        // Move to the single parent for the next iteration
                        const singleParentEntry = parentEntries[0];
                        if (!singleParentEntry || singleParentEntry.is_immutable) {
                            break; // Stop if the parent is immutable or not found
                        }

                        currentFocus = singleParentEntry;
                        ancestorDepth++;
                    }
                }

                // 3. Update Working Copy Group & Collect Decorations
                const decorationMap = new Map<string, JjStatusEntry>();

                // Working Copy Changes
                const changes = currentEntry?.changes || [];
                this._workingCopyStatuses.clear();

                if (currentEntry) {
                    const config = vscode.workspace.getConfiguration('jj-view');
                    const minChangeIdLength = config.get<number>('minChangeIdLength', 1);
                    const shortId = formatDisplayChangeId(
                        currentEntry.change_id,
                        currentEntry.change_id_shortest,
                        minChangeIdLength,
                    );
                    this._workingCopyGroup.label = `Working Copy - ${shortId}`;
                } else {
                    this._workingCopyGroup.label = 'Working Copy';
                }

                // Working copy items are squashable if the parent is mutable
                this._workingCopyGroup.resourceStates = changes.map((c) => {
                    const state = this.toResourceState(c, currentEntry?.change_id || '@', {
                        squashable: parentMutable,
                        multipleAncestors: ancestorsToDisplay.length > 1,
                        openDiffOnClick,
                    });
                    decorationMap.set(state.resourceUri.toString(), c);
                    this._workingCopyStatuses.set(state.resourceUri.fsPath, c);
                    return state;
                });

                // 4. Update Conflict Group (conflictedPaths fetched above)
                this._conflictGroup.resourceStates = conflictedPaths.map((path) => {
                    const entry: JjStatusEntry = { path, status: 'modified', conflicted: true };
                    const state = this.toResourceState(entry, currentEntry?.change_id || '@', { openDiffOnClick });
                    decorationMap.set(state.resourceUri.toString(), entry);
                    return state;
                });
                this._conflictGroup.hideWhenEmpty = true;

                // 5. Update Parent Groups
                // Dispose excess parent groups
                while (this._parentGroups.length > ancestorsToDisplay.length) {
                    const group = this._parentGroups.pop();
                    group?.dispose();
                }

                // Populate the SCM groups
                for (let i = 0; i < ancestorsToDisplay.length; i++) {
                    const { entry: ancestorEntry, prefix, isMutable, canSquash } = ancestorsToDisplay[i];

                    const config = vscode.workspace.getConfiguration('jj-view');
                    const minChangeIdLength = config.get<number>('minChangeIdLength', 1);
                    const shortId = formatDisplayChangeId(
                        ancestorEntry.change_id,
                        ancestorEntry.change_id_shortest,
                        minChangeIdLength,
                    );
                    const desc = ancestorEntry.description?.trim() || '(no description)';
                    const label = `${prefix}: ${shortId} - ${desc}`;

                    // Reuse existing group or create new one
                    let group: vscode.SourceControlResourceGroup;
                    const contextValue = canSquash
                        ? ScmContextValue.AncestorGroupSquashable
                        : ScmContextValue.AncestorGroupMutable;

                    if (i < this._parentGroups.length) {
                        group = this._parentGroups[i];
                        group.label = label;
                        group.contextValue = contextValue;
                    } else {
                        const groupId = `ancestor-${i}`;
                        group = this._sourceControl.createResourceGroup(groupId, label);
                        group.hideWhenEmpty = false;
                        group.contextValue = contextValue;
                        this._parentGroups.push(group);
                    }

                    const parentChanges = ancestorEntry.changes || [];
                    group.resourceStates = parentChanges.map((c: JjStatusEntry) => {
                        // Level i ancestor has (ancestorsToDisplay.length - 1 - i) mutable ancestors below it.
                        const remainingAncestors = ancestorsToDisplay.length - 1 - i;
                        const state = this.toResourceState(c, ancestorEntry.change_id, {
                            editable: isMutable,
                            squashable: canSquash,
                            multipleAncestors: remainingAncestors > 0,
                            openDiffOnClick,
                        });
                        decorationMap.set(state.resourceUri.toString(), c);
                        return state;
                    });
                }

                // Update Decoration
                this.decorationProvider.updateScmAndTrackedStatus(decorationMap);

                // Update SCM Count - Only count Working Copy changes
                // VS Code sums all groups by default if count is not set, so we must set it explicitly.
                this._sourceControl.count = this._workingCopyGroup.resourceStates.length;
            } catch (e: unknown) {
                const err = e as { message?: string };
                if (JjService.isIndexLockError(e)) {
                    const repoRoot = await this.jj.getRepoRoot();
                    const lockPath = path.join(repoRoot, '.git', 'index.lock');
                    const DELETE_LOCK = 'Delete Lock File';
                    vscode.window
                        .showErrorMessage(
                            `jj failed: Git index is locked. Another process may have crashed. Delete .git/index.lock to resolve.`,
                            DELETE_LOCK,
                            'Show Log',
                        )
                        .then(async (selection) => {
                            if (selection === DELETE_LOCK) {
                                try {
                                    await fs.unlink(lockPath);
                                    this.outputChannel.appendLine(`[Info] Deleted lock file at ${lockPath}`);
                                    await this.refresh({ forceSnapshot: true, reason: 'lock file deleted' });
                                } catch (unlinkErr) {
                                    this.outputChannel.appendLine(
                                        `[Error] Failed to delete lock file: ${getErrorMessage(unlinkErr)}`,
                                    );
                                    vscode.window.showErrorMessage(
                                        `Failed to delete lock file: ${getErrorMessage(unlinkErr)}`,
                                    );
                                }
                            } else if (selection === 'Show Log') {
                                this.outputChannel.show();
                            }
                        });
                } else if (
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

                    // Invalidate caches once state is fully updated to ensure
                    // that when VS Code re-queries, it sees the most up-to-date state.
                    this.viewFileSystemProvider?.invalidateCache();
                    this.editProvider?.invalidateCache();

                    // Re-assigning quickDiffProvider is a known workaround to force
                    // VS Code to re-evaluate provideOriginalResource for all open editors.
                    this._sourceControl.quickDiffProvider = this;
                }
            }
        });

        return this._refreshMutex;
    }

    async abandon(revisions: string[]) {
        if (revisions.length === 0) {
            return;
        }
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

    private toResourceState(
        entry: JjStatusEntry,
        revision: string = '@',
        options: {
            editable?: boolean;
            workingCopyChangeId?: string;
            squashable?: boolean;
            multipleAncestors?: boolean;
            openDiffOnClick?: boolean;
        } = {},
    ): JjResourceState {
        const root = this._sourceControl.rootUri?.fsPath || '';
        const isCurrentWorkingCopy = revision === '@' || revision === this._currentEntry?.change_id;
        const { leftUri, rightUri, resourceUri } = createDiffUris(entry, revision, root, {
            ...options,
            workingCopyChangeId: this._currentEntry?.change_id,
        });

        const openDiffOnClick = options.openDiffOnClick ?? true;
        const isDeleted = entry.status === 'removed' || entry.status === 'deleted';

        const diffTitle = `${entry.path} (${isCurrentWorkingCopy ? 'Working Copy' : revision})`;

        const diffCommand: vscode.Command = {
            command: 'vscode.diff',
            title: 'Open Changes',
            arguments: [leftUri, rightUri, diffTitle],
        };

        const command: vscode.Command = entry.conflicted
            ? {
                  command: 'jj-view.openMergeEditor',
                  title: 'Open 3-Way Merge',
                  arguments: [{ resourceUri }],
              }
            : openDiffOnClick || isDeleted
              ? diffCommand
              : {
                    command: 'vscode.open',
                    title: 'Open File',
                    arguments: [resourceUri.with({ query: '' })],
                };

        return {
            resourceUri,
            command,
            leftUri,
            rightUri,
            diffTitle,
            decorations: {
                tooltip: entry.conflicted ? 'Conflicted' : entry.status,
                faded: false,
                strikeThrough: entry.status === 'removed',
            },
            contextValue: entry.conflicted
                ? ScmContextValue.Conflict
                : isCurrentWorkingCopy
                  ? options.squashable
                      ? options.multipleAncestors
                          ? ScmContextValue.WorkingCopySquashableMulti
                          : ScmContextValue.WorkingCopySquashable
                      : ScmContextValue.WorkingCopy
                  : options.squashable
                    ? options.multipleAncestors
                        ? ScmContextValue.AncestorSquashableMulti
                        : ScmContextValue.AncestorSquashable
                    : ScmContextValue.AncestorMutable,
            revision: revision,
        };
    }

    provideOriginalResource(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
        const statusEntry = this._workingCopyStatuses.get(uri.fsPath);
        if (!statusEntry || statusEntry.status === 'added') {
            return undefined;
        }

        const query = new URLSearchParams(uri.query);
        const revision = query.get('jj-revision') || '@';

        let originalUri = uri;
        if (statusEntry.oldPath) {
            originalUri = vscode.Uri.file(path.join(this.jj.workspaceRoot, statusEntry.oldPath));
        }

        return originalUri.with({ scheme: 'jj-view', query: `base=${revision}&side=left` });
    }

    get sourceControl(): vscode.SourceControl {
        return this._sourceControl;
    }

    dispose() {
        this._disposed = true;
        this.disposables.forEach((d) => {
            d.dispose();
        });
    }
}
