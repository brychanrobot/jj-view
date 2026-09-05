/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { toError } from '../utils/error-utils';
import { canAbsorbCommit, canSquashCommit, formatDisplayChangeId, isMutableCommit } from '../utils/jj-utils';
import type { LoggerChannel } from '../utils/output-channel';
import { type AsyncEvent, AsyncEventEmitter, type Disposable } from './host/events';
import { ScmContextValue } from './jj-context-keys';
import type { JjRepository } from './jj-repository';
import type { JjService } from './jj-service';
import type { CommitParent, JjLogEntry, JjStatusEntry } from './jj-types';
import { encodeJjViewQuery, getRepoRelativePath, getRevisionFromUri, Uri } from './uri-utils';

export interface ScmAncestorEntry {
    entry: JjLogEntry;
    prefix: string;
    isMutable: boolean;
    canSquash: boolean;
    changes: JjStatusEntry[];
    label: string;
    contextValue: string;
}

export interface ScmSnapshot {
    currentEntry: JjLogEntry | undefined;
    workingCopyChanges: JjStatusEntry[];
    workingCopyStatuses: Map<string, JjStatusEntry>;
    workingCopyLabel: string;
    workingCopyContextValue: string;
    conflictedPaths: string[];
    ancestors: ScmAncestorEntry[];
    parentMutable: boolean;
    hasChild: boolean;
    description: string;
    workingCopyCount: number;
}

export class ScmModel implements Disposable {
    private _disposed = false;
    private disposables: Disposable[] = [];
    private _snapshot: ScmSnapshot | undefined;
    private _selectedCommitIds: string[] = [];
    private _workingCopyStatuses = new Map<string, JjStatusEntry>();
    private _parentMutable = false;
    private _hasChild = false;
    private _currentEntry: JjLogEntry | undefined;

    private readonly _onDidChangeSnapshot = new AsyncEventEmitter<ScmSnapshot>();
    public readonly onDidChangeSnapshot: AsyncEvent<ScmSnapshot> = this._onDidChangeSnapshot.event;

    private readonly _onDidChangeStatus = new AsyncEventEmitter<void>();
    public readonly onDidChangeStatus: AsyncEvent<void> = this._onDidChangeStatus.event;

    constructor(
        public readonly repo: JjRepository,
        public readonly outputChannel: LoggerChannel,
    ) {
        this.disposables.push(
            this.repo.onDidStatusChange(async (event) => {
                await this.updateSnapshot(event);
            }),
        );
    }

    get jj(): JjService {
        return this.repo.jj;
    }

    get snapshot(): ScmSnapshot | undefined {
        return this._snapshot;
    }

    get parentMutable(): boolean {
        return this._parentMutable;
    }

    get hasChild(): boolean {
        return this._hasChild;
    }

    get currentEntry(): JjLogEntry | undefined {
        return this._currentEntry;
    }

    public getWorkingCopyStatuses(): Map<string, JjStatusEntry> {
        return this._workingCopyStatuses;
    }

    public handleSelectionChange(commitIds: string[]): void {
        this._selectedCommitIds = commitIds;
    }

    public getSelectedCommitIds(): string[] {
        return this._selectedCommitIds;
    }

    public async refresh(options: { forceSnapshot?: boolean; reason?: string } = {}): Promise<void> {
        await this.repo.refresh(options);
    }

    public async abandon(revisions: string[]): Promise<void> {
        if (revisions.length === 0) {
            return;
        }
        await this.jj.abandon(revisions);
        await this.repo.refresh();
    }

    public async restore(paths: string[]): Promise<void> {
        await this.jj.restore(paths);
        await this.repo.refresh();
    }

    public async setDescription(message: string): Promise<void> {
        await this.jj.describe(message);
        await this.repo.refresh();
    }

    public getOriginalResourceUri(uri: Uri): Uri | undefined {
        const relativePath = getRepoRelativePath(uri, this.jj.workspaceRoot);
        const statusEntry = this._workingCopyStatuses.get(relativePath);
        if (!statusEntry || statusEntry.status === 'added') {
            return undefined;
        }

        const revision = getRevisionFromUri(uri) || '@';
        const leftPath = statusEntry.oldPath || statusEntry.path;
        const relPath = leftPath.startsWith('/') ? leftPath : `/${leftPath}`;

        return Uri.from({
            scheme: 'jj-view',
            path: relPath,
            fragment: encodeJjViewQuery({ mode: 'diff', root: this.jj.workspaceRoot, base: revision, side: 'left' }),
        });
    }

    public async updateSnapshot(event: { reason: string }): Promise<void> {
        if (this._disposed) {
            return;
        }
        const reasonStr = event.reason ? ` (reason: ${event.reason})` : '';
        this.outputChannel.info(`Updating SCM Model${reasonStr}...`);
        const start = performance.now();

        try {
            const maxMutableAncestors = this.repo.host.config.get<number>('maxMutableAncestors', 10) ?? 10;
            const minChangeIdLength = this.repo.host.config.get<number>('minChangeIdLength', 1) ?? 1;
            const limit = maxMutableAncestors + 1;

            const bulkLogPromise = this.jj.getLog({
                revision: `(::@ & mutable()) | parents(roots(::@ & mutable()))`,
                limit,
            });

            const [bulkLog, workingCopyEntries, children, conflictedPaths] = await Promise.all([
                bulkLogPromise,
                this.jj.getLog({ revision: '@', limit: 1 }),
                this.jj.getChildren('@'),
                this.jj.getConflictedFiles(),
            ]);

            const currentEntry = workingCopyEntries[0] || bulkLog.find((e) => e.is_current_working_copy) || bulkLog[0];
            this._currentEntry = currentEntry;
            const bulkLogMap = new Map<string, JjLogEntry>(bulkLog.map((entry) => [entry.commit_id, entry]));
            if (currentEntry) {
                bulkLogMap.set(currentEntry.commit_id, currentEntry);
            }

            this._parentMutable = this.isParentMutable(currentEntry);
            this._hasChild = children.length > 0;

            const ancestors = this.computeMutableAncestors(
                currentEntry,
                bulkLogMap,
                maxMutableAncestors,
                minChangeIdLength,
            );

            const workingCopyChanges = currentEntry?.changes || [];
            this._workingCopyStatuses = this.buildWorkingCopyStatusMap(workingCopyChanges, conflictedPaths);

            this._snapshot = {
                currentEntry,
                workingCopyChanges,
                workingCopyStatuses: new Map(this._workingCopyStatuses),
                workingCopyLabel: this.computeWorkingCopyLabel(currentEntry, minChangeIdLength),
                workingCopyContextValue: this.computeWorkingCopyContextValue(currentEntry),
                conflictedPaths,
                ancestors,
                parentMutable: this._parentMutable,
                hasChild: this._hasChild,
                description: currentEntry?.description ? currentEntry.description.trim() : '',
                workingCopyCount: workingCopyChanges.length,
            };

            await this._onDidChangeSnapshot.fire(this._snapshot);
        } catch (e: unknown) {
            this.outputChannel.error(`[${this.repo.rootUri.fsPath}] Error calculating SCM snapshot`, toError(e));
        } finally {
            if (!this._disposed) {
                const duration = performance.now() - start;
                const changeCount = this._snapshot?.workingCopyCount ?? 0;
                const ancestorCount = this._snapshot?.ancestors.length ?? 0;
                this.outputChannel.info(
                    `[timing] [SCM] refresh took ${duration.toFixed(0)}ms (${changeCount} changes, ${ancestorCount} ancestors)`,
                );
                await this._onDidChangeStatus.fire();
            }
        }
    }

    private isParentMutable(currentEntry: JjLogEntry | undefined): boolean {
        if (!currentEntry?.parents || currentEntry.parents.length === 0) {
            return false;
        }
        return !currentEntry.parents[0].is_immutable;
    }

    private computeMutableAncestors(
        currentEntry: JjLogEntry | undefined,
        bulkLogMap: Map<string, JjLogEntry>,
        maxMutableAncestors: number,
        minChangeIdLength: number,
    ): ScmAncestorEntry[] {
        if (!currentEntry) {
            return [];
        }

        const ancestorsToDisplay: ScmAncestorEntry[] = [];
        let currentFocus: JjLogEntry | undefined = currentEntry;
        let ancestorDepth = 1;

        while (currentFocus && ancestorsToDisplay.length < maxMutableAncestors) {
            const parents: CommitParent[] | undefined = currentFocus.parents;
            if (!parents || parents.length === 0) {
                break;
            }

            const isMerge = parents.length > 1;
            const parentEntries: (JjLogEntry | undefined)[] = parents.map((parent: CommitParent) =>
                bulkLogMap.get(parent.commit_id),
            );

            for (let i = 0; i < parentEntries.length; i++) {
                const parentEntry = parentEntries[i];
                if (!parentEntry || parentEntry.is_immutable) {
                    continue;
                }

                const prefix = isMerge ? `@-${ancestorDepth}^${i + 1}` : `@-${ancestorDepth}`;
                ancestorsToDisplay.push(this.createAncestorEntry(parentEntry, prefix, minChangeIdLength));
            }

            if (isMerge) {
                break;
            }

            const singleParentEntry: JjLogEntry | undefined = parentEntries[0];
            if (!singleParentEntry || singleParentEntry.is_immutable) {
                break;
            }

            currentFocus = singleParentEntry;
            ancestorDepth++;
        }

        return ancestorsToDisplay;
    }

    private createAncestorEntry(parentEntry: JjLogEntry, prefix: string, minChangeIdLength: number): ScmAncestorEntry {
        const canSquash =
            !parentEntry.is_immutable &&
            parentEntry.parents !== undefined &&
            parentEntry.parents.length > 0 &&
            !parentEntry.parents[0].is_immutable;

        const shortId = formatDisplayChangeId(parentEntry.change_id, parentEntry.change_id_shortest, minChangeIdLength);
        const desc = parentEntry.description?.trim() || '(no description)';
        const subject = desc.split('\n', 1)[0].trim();
        const label = `${prefix}: ${shortId} - ${subject}`;

        const groupFlags: string[] = [
            ScmContextValue.GroupAllowShowMultiFileDiff,
            ScmContextValue.GroupAllowShowDetails,
        ];
        if (isMutableCommit(parentEntry)) {
            groupFlags.push(ScmContextValue.GroupAllowEdit);
        }
        if (canSquashCommit(parentEntry)) {
            groupFlags.push(ScmContextValue.GroupAllowSquash);
        }

        return {
            entry: parentEntry,
            prefix,
            isMutable: !parentEntry.is_immutable,
            canSquash,
            changes: parentEntry.changes || [],
            label,
            contextValue: groupFlags.join(' '),
        };
    }

    private buildWorkingCopyStatusMap(changes: JjStatusEntry[], conflictedPaths: string[]): Map<string, JjStatusEntry> {
        const statusMap = new Map<string, JjStatusEntry>();

        for (const c of changes) {
            const withSlash = c.path.startsWith('/') ? c.path : `/${c.path}`;
            const withoutSlash = c.path.startsWith('/') ? c.path.slice(1) : c.path;
            statusMap.set(withSlash, c);
            statusMap.set(withoutSlash, c);
        }

        for (const cPath of conflictedPaths) {
            const entry: JjStatusEntry = { path: cPath, status: 'modified', conflicted: true };
            const withSlash = cPath.startsWith('/') ? cPath : `/${cPath}`;
            const withoutSlash = cPath.startsWith('/') ? cPath.slice(1) : cPath;
            statusMap.set(withSlash, entry);
            statusMap.set(withoutSlash, entry);
        }

        return statusMap;
    }

    private computeWorkingCopyLabel(currentEntry: JjLogEntry | undefined, minChangeIdLength: number): string {
        if (!currentEntry) {
            return 'Working Copy';
        }
        const shortId = formatDisplayChangeId(
            currentEntry.change_id,
            currentEntry.change_id_shortest,
            minChangeIdLength,
        );
        return `Working Copy - ${shortId}`;
    }

    private computeWorkingCopyContextValue(currentEntry: JjLogEntry | undefined): string {
        const wcFlags: string[] = [
            ScmContextValue.WorkingCopyGroup,
            ScmContextValue.GroupAllowShowMultiFileDiff,
            ScmContextValue.GroupAllowAbandon,
        ];
        if (currentEntry) {
            if (canAbsorbCommit(currentEntry)) {
                wcFlags.push(ScmContextValue.GroupAllowAbsorb);
            }
            if (canSquashCommit(currentEntry)) {
                wcFlags.push(ScmContextValue.GroupAllowSquash);
            }
        }
        return wcFlags.join(' ');
    }

    public dispose(): void {
        this._disposed = true;
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
        this._onDidChangeSnapshot.dispose();
        this._onDidChangeStatus.dispose();
    }
}
