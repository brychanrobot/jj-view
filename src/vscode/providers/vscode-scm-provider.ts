/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { DiffTabCleaner } from '../../diff-tab-cleaner';
import { JjContextKey, ScmContextValue } from '../../jj-context-keys';
import { JjDecorationModel } from '../../jj-decoration-model';
import type { JjRepository } from '../../jj-repository';
import type { JjRepositoryManager } from '../../jj-repository-manager';
import type { JjService } from '../../jj-service';
import type { JjStatusEntry } from '../../jj-types';
import { ScmModel, type ScmSnapshot } from '../../scm-model';
import { createJjResourceState, type JjResourceState } from '../../scm-resource-state';
import { getRepoRelativePath, type Uri } from '../../uri-utils';
import { getJjViewConfig } from '../../utils/config-utils';
import type { LoggerChannel } from '../../utils/output-channel';
import { VsCodeDecorationProvider } from './vscode-decoration-provider';
import type { VsCodeEditFsProvider } from './vscode-edit-fs-provider';
import type { VsCodeViewFsProvider } from './vscode-view-fs-provider';

export class VsCodeScmProvider implements vscode.Disposable {
    private _disposed = false;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly _sourceControl: vscode.SourceControl;
    private readonly _workingCopyGroup: vscode.SourceControlResourceGroup;
    private readonly _parentGroups: vscode.SourceControlResourceGroup[] = [];
    private readonly _conflictGroup: vscode.SourceControlResourceGroup;
    private _lastKnownDescription = '';
    private _lastKnownCommitId = '';
    private readonly _diffTabCleaner: DiffTabCleaner;

    public readonly scmModel: ScmModel;
    public readonly decorationProvider: VsCodeDecorationProvider;

    get parentMutable(): boolean {
        return this.scmModel.parentMutable;
    }

    get hasChild(): boolean {
        return this.scmModel.hasChild;
    }

    get jj(): JjService {
        return this.repo.jj;
    }

    public ownsGroup(group: vscode.SourceControlResourceGroup): boolean {
        return group === this._workingCopyGroup || group === this._conflictGroup || this._parentGroups.includes(group);
    }

    get onDidChangeStatus(): vscode.Event<void> {
        return (listener, thisArgs, disposables) => {
            const disposable = this.scmModel.onDidChangeStatus(() => listener.call(thisArgs));
            if (disposables) {
                disposables.push(disposable);
            }
            return disposable;
        };
    }

    get sourceControl(): vscode.SourceControl {
        return this._sourceControl;
    }

    constructor(
        public readonly context: vscode.ExtensionContext,
        public readonly repo: JjRepository,
        public readonly outputChannel: LoggerChannel,
        public readonly repositoryManager: JjRepositoryManager,
        public readonly viewFileSystemProvider?: VsCodeViewFsProvider,
        public readonly editProvider?: VsCodeEditFsProvider,
        public readonly isFocused: () => boolean = () => true,
        scmModel?: ScmModel,
    ) {
        this.scmModel = scmModel ?? new ScmModel(repo, outputChannel);
        this.disposables.push(this.scmModel);

        const workspaceRoot = repo.rootUri.fsPath;
        const folderName = path.basename(workspaceRoot);
        this._sourceControl = vscode.scm.createSourceControl(
            `jj-${workspaceRoot}`,
            `Jujutsu (${folderName})`,
            repo.rootUri,
        );
        const decorationModel = new JjDecorationModel(this.jj, workspaceRoot);
        this.decorationProvider = new VsCodeDecorationProvider(decorationModel);

        const belongsToRepo = (uri: Uri) => {
            return this.repositoryManager.getRepositoryForUri(uri) === this.repo;
        };
        this._diffTabCleaner = new DiffTabCleaner(this.jj, belongsToRepo, this.outputChannel);

        this._conflictGroup = this._sourceControl.createResourceGroup(ScmContextValue.ConflictGroup, 'Merge Conflicts');
        this._conflictGroup.hideWhenEmpty = true;
        this._workingCopyGroup = this._sourceControl.createResourceGroup(
            ScmContextValue.WorkingCopyGroup,
            'Working Copy',
        );
        this._workingCopyGroup.hideWhenEmpty = false;

        this._sourceControl.quickDiffProvider = this;
        this._sourceControl.inputBox.placeholder = 'Describe your changes...';
        this._sourceControl.acceptInputCommand = { command: 'jj-view.commit', title: 'Commit (Ctrl+Enter)' };

        this.disposables.push(this._sourceControl);
        this.disposables.push(this._conflictGroup);
        this.disposables.push(this._workingCopyGroup);
        this.disposables.push(this.decorationProvider);

        this.disposables.push(
            this.scmModel.onDidChangeSnapshot(async (snapshot) => {
                await this.renderSnapshot(snapshot);
            }),
        );

        // Initial refresh
        this.refresh({ forceSnapshot: true, reason: 'initialization' }).catch((err) => {
            try {
                this.outputChannel.error(`[VsCodeScmProvider] Initial refresh failed: ${err}`);
            } catch {
                // Ignore channel closed errors
            }
        });
    }

    public async refresh(options: { forceSnapshot?: boolean; reason?: string } = {}): Promise<void> {
        await this.scmModel.refresh(options);
    }

    public handleSelectionChange(commitIds: string[]): void {
        this.scmModel.handleSelectionChange(commitIds);
    }

    public getSelectedCommitIds(): string[] {
        return this.scmModel.getSelectedCommitIds();
    }

    private async renderSnapshot(snapshot: ScmSnapshot): Promise<void> {
        if (this._disposed) {
            return;
        }

        const openDiffOnClick = getJjViewConfig<boolean>('openDiffOnClick', true) ?? true;
        const currentEntry = snapshot.currentEntry;

        if (currentEntry) {
            const desc = snapshot.description;
            const commitId = currentEntry.change_id;

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

        if (this.isFocused()) {
            await vscode.commands.executeCommand('setContext', JjContextKey.ParentMutable, snapshot.parentMutable);
            await vscode.commands.executeCommand('setContext', JjContextKey.HasChild, snapshot.hasChild);
        }

        const decorationMap = new Map<string, JjStatusEntry>();

        this._workingCopyGroup.label = snapshot.workingCopyLabel;
        this._workingCopyGroup.contextValue = snapshot.workingCopyContextValue;

        this._workingCopyGroup.resourceStates = snapshot.workingCopyChanges.map((c) => {
            const state = this.toResourceState(c, currentEntry?.change_id || '@', {
                squashable: snapshot.parentMutable,
                multipleAncestors: snapshot.ancestors.length > 1,
                openDiffOnClick,
                hasChild: snapshot.hasChild,
            });
            decorationMap.set(state.resourceUri.toString(), c);
            decorationMap.set(getRepoRelativePath(state.resourceUri, this.jj.workspaceRoot), c);
            return state;
        });

        this._conflictGroup.resourceStates = snapshot.conflictedPaths.map((cPath) => {
            const entry: JjStatusEntry = { path: cPath, status: 'modified', conflicted: true };
            const state = this.toResourceState(entry, currentEntry?.change_id || '@', {
                openDiffOnClick,
                inConflictGroup: true,
            });
            decorationMap.set(state.resourceUri.toString(), entry);
            decorationMap.set(getRepoRelativePath(state.resourceUri, this.jj.workspaceRoot), entry);
            return state;
        });

        while (this._parentGroups.length > snapshot.ancestors.length) {
            const group = this._parentGroups.pop();
            group?.dispose();
        }

        for (let i = 0; i < snapshot.ancestors.length; i++) {
            const ancestor = snapshot.ancestors[i];
            let group: vscode.SourceControlResourceGroup;

            if (i < this._parentGroups.length) {
                group = this._parentGroups[i];
                group.label = ancestor.label;
                group.contextValue = ancestor.contextValue;
            } else {
                const groupId = `ancestor-${i}`;
                group = this._sourceControl.createResourceGroup(groupId, ancestor.label);
                group.hideWhenEmpty = false;
                group.contextValue = ancestor.contextValue;
                this._parentGroups.push(group);
            }

            const remainingAncestors = snapshot.ancestors.length - 1 - i;
            group.resourceStates = ancestor.changes.map((c: JjStatusEntry) => {
                const state = this.toResourceState(c, ancestor.entry.change_id, {
                    editable: ancestor.isMutable,
                    squashable: ancestor.canSquash,
                    multipleAncestors: remainingAncestors > 0,
                    openDiffOnClick,
                });
                decorationMap.set(state.resourceUri.toString(), c);
                return state;
            });
        }

        this.decorationProvider.updateScmAndTrackedStatus(decorationMap);
        this._sourceControl.count = snapshot.workingCopyCount;

        this.viewFileSystemProvider?.invalidateCache();
        this.editProvider?.invalidateCache();
        this._sourceControl.quickDiffProvider = this;

        await this._diffTabCleaner.closeInvalidDiffEditors();
    }

    private toResourceState(
        entry: JjStatusEntry,
        revision = '@',
        options: Parameters<typeof createJjResourceState>[3] = {},
    ): JjResourceState {
        return createJjResourceState(entry, revision, this._sourceControl.rootUri?.fsPath || '', {
            ...options,
            workingCopyChangeId: this.scmModel.currentEntry?.change_id,
        });
    }

    provideOriginalResource(uri: Uri): vscode.ProviderResult<Uri> {
        return this.scmModel.getOriginalResourceUri(uri);
    }

    dispose(): void {
        this._disposed = true;
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
    }
}
