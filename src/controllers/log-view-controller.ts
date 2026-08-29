/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Disposable, type Event, EventEmitter } from '../common/events';
import type { HostEnvironment } from '../common/host-environment';
import {
    type LogViewHostToWebviewMessage,
    type LogViewPayload,
    type LogViewToHostMessage,
    LogViewToHostMessageSchema,
    TOGGLEABLE_COMMIT_ACTIONS,
    type ToggleableCommitAction,
} from '../common/ipc/log-view-schemas';
import { showJjError } from '../common/ui-helpers';
import {
    createWebviewRpcDispatcher,
    type WebviewPostMessageLike,
    type WebviewRpcDispatcher,
} from '../common/webview-rpc-dispatcher';
import { JjContextKey } from '../jj-context-keys';
import type { JjRepository } from '../jj-repository';
import type { JjService } from '../jj-service';
import type { JjLogEntry } from '../jj-types';
import { Uri } from '../uri-utils';
import { CoalescingQueue } from '../utils/coalescing-queue';
import { toError } from '../utils/error-utils';
import { canAbsorbCommit } from '../utils/jj-utils';
import type { LoggerChannel } from '../utils/output-channel';

export interface LogViewControllerOptions {
    messenger?: WebviewPostMessageLike;
    logger?: LoggerChannel;
    onSelectionChange?: (commitIds: string[]) => void;
    closeCommitDetailsTabs?: (predicate: (repoRoot?: Uri) => boolean) => Promise<void> | void;
}

export class LogViewController implements Disposable {
    private static readonly HIDDEN_ACTIONS_STORAGE_KEY = 'jj-view.hiddenCommitActions';
    private _disposed = false;
    private readonly _disposables: Disposable[] = [];
    private _codeForgeDisposable: Disposable | undefined;
    private readonly _logger?: LoggerChannel;
    private readonly _dispatcher: WebviewRpcDispatcher<LogViewToHostMessage, LogViewHostToWebviewMessage>;
    private readonly _refreshQueue: CoalescingQueue;

    private _commits: readonly JjLogEntry[] = [];
    private _selectedCommitIds: readonly string[] = [];
    private _hiddenActions: readonly ToggleableCommitAction[] = [];
    private _theme: string;
    private _graphLabelAlignment: string;
    private _minChangeIdLength: number;

    private readonly _onDidUpdateCommits = new EventEmitter<readonly JjLogEntry[]>();
    public readonly onDidUpdateCommits: Event<readonly JjLogEntry[]> = this._onDidUpdateCommits.event;

    private readonly _onDidChangeSelection = new EventEmitter<readonly string[]>();
    public readonly onDidChangeSelection: Event<readonly string[]> = this._onDidChangeSelection.event;

    constructor(
        private _repo: JjRepository | undefined,
        private readonly _host: HostEnvironment,
        private readonly _options?: LogViewControllerOptions,
    ) {
        this._logger = _options?.logger;
        this._theme = this._host.config.get<string>('logTheme', 'default');
        this._graphLabelAlignment = this._host.config.get<string>('graphLabelAlignment', 'aligned');
        this._minChangeIdLength = this._host.config.get<number>('minChangeIdLength', 1);

        this._refreshQueue = new CoalescingQueue(async () => {
            await this._doRefresh();
        });

        this._dispatcher = this._createRpcDispatcher();
        if (_options?.messenger) {
            this._dispatcher.setMessenger(_options.messenger);
        }

        const storedHidden = this._host.storage.get<string[]>(LogViewController.HIDDEN_ACTIONS_STORAGE_KEY, []) ?? [];
        this.setHiddenActions(storedHidden);

        this.bindRepo(this._repo);

        if (this._host.config.onDidChangeConfiguration) {
            this._disposables.push(
                this._host.config.onDidChangeConfiguration((e) => {
                    if (
                        e.affectsConfiguration('jj-view.logTheme') ||
                        e.affectsConfiguration('jj-view.graphLabelAlignment') ||
                        e.affectsConfiguration('jj-view.minChangeIdLength')
                    ) {
                        this.updateConfig({
                            theme: this._host.config.get<string>('logTheme', 'default'),
                            graphLabelAlignment: this._host.config.get<string>('graphLabelAlignment', 'aligned'),
                            minChangeIdLength: this._host.config.get<number>('minChangeIdLength', 1),
                        });
                    }
                }),
            );
        }
    }

    public get commits(): readonly JjLogEntry[] {
        return this._commits;
    }

    public get cachedCommits(): readonly JjLogEntry[] {
        return this._commits;
    }

    public get selectedCommitIds(): readonly string[] {
        return this._selectedCommitIds;
    }

    public get hiddenActions(): readonly ToggleableCommitAction[] {
        return this._hiddenActions;
    }

    public get theme(): string {
        return this._theme;
    }

    public get graphLabelAlignment(): string {
        return this._graphLabelAlignment;
    }

    public get minChangeIdLength(): number {
        return this._minChangeIdLength;
    }

    public getState(): LogViewPayload {
        return {
            commits: [...this._commits],
            minChangeIdLength: this._minChangeIdLength,
            theme: this._theme,
            graphLabelAlignment: this._graphLabelAlignment,
            hiddenActions: [...this._hiddenActions],
        };
    }

    public get repository(): JjRepository | undefined {
        return this._repo;
    }

    public set repository(repo: JjRepository | undefined) {
        if (this._disposed || this._repo?.rootUri.fsPath === repo?.rootUri.fsPath) {
            return;
        }
        this._repo = repo;
        this._selectedCommitIds = [];
        this._updateSelectionContextKeys(this._selectedCommitIds);
        this.bindRepo(repo);
        this.refresh('repoChanged');
    }

    public get jj(): JjService | undefined {
        return this._repo?.jj;
    }

    public setMessenger(messenger: WebviewPostMessageLike | undefined): void {
        this._dispatcher.setMessenger(messenger);
    }

    private bindRepo(repo: JjRepository | undefined): void {
        this._codeForgeDisposable?.dispose();
        this._codeForgeDisposable = undefined;

        if (!repo) {
            return;
        }

        const cf = repo.codeForge;
        this._codeForgeDisposable = cf.onDidUpdate(() => {
            this.refreshCodeForge().catch((e) => {
                this._logger?.error('[LogViewController] CodeForge update failed', toError(e));
            });
        });

        cf.detectActiveProvider(true).catch((e) => {
            this._logger?.error('Code forge detection failed', toError(e));
        });
    }

    public async handleMessage(rawMessage: unknown): Promise<boolean> {
        if (this._disposed) {
            return false;
        }
        return this._dispatcher.dispatch(rawMessage);
    }

    public async refresh(reason?: string): Promise<void> {
        if (this._disposed) {
            return;
        }
        const reasonStr = reason ? ` (reason: ${reason})` : '';
        this._logger?.info?.(`[LogViewController] Queuing refresh${reasonStr}...`);
        await this._refreshQueue.run();
    }

    private async _doRefresh(): Promise<void> {
        if (!this._repo || !(await this._repo.isValid())) {
            this._logger?.info?.(
                `[LogViewController] ${this._repo ? this._repo.rootUri.fsPath : 'No repository'} is not valid. Clearing commits.`,
            );
            this.setCommits([]);
            return;
        }

        const jj = this._repo.jj;
        const targetRepoPath = this._repo.rootUri.fsPath;

        try {
            const start = performance.now();
            const commits = await jj.getLog({
                omitChanges: true,
                includeNearestVisibleAncestors: true,
            });

            if (this._repo?.rootUri.fsPath !== targetRepoPath || this._disposed) {
                this._logger?.info?.(
                    `[LogViewController] Repository changed during fetch (was ${targetRepoPath}). Discarding stale log.`,
                );
                return;
            }

            const duration = performance.now() - start;
            this._logger?.info?.(
                `[LogViewController] jj log took ${duration.toFixed(0)}ms, found ${commits.length} commits`,
            );

            this.setCommits(commits);
        } catch (e) {
            this._logger?.error('[LogViewController] Failed to fetch log', toError(e));
            return;
        }

        this.refreshCodeForge().catch((e) => {
            this._logger?.error('[LogViewController] Background refreshCodeForge failed', toError(e));
        });
    }

    public setCommits(commits: readonly JjLogEntry[]): void {
        const enrichedCommits = [...commits];
        const cf = this._repo?.codeForge;
        if (cf?.isEnabled) {
            cf.populateCodeForgeInfo(enrichedCommits);
        }

        this._commits = enrichedCommits;
        this._updateSelectionContextKeys(this._selectedCommitIds);

        if (this._disposed) {
            return;
        }

        this._onDidUpdateCommits.fire(enrichedCommits);

        this._dispatcher.emitter.update(this.getState());
    }

    private _updateSelectionContextKeys(selectedCommitIds: readonly string[], hasImmutableSelection?: boolean): void {
        const count = selectedCommitIds.length;
        const selectedCommits = this._commits.filter((c) => selectedCommitIds.includes(c.change_id));
        const containsImmutable = hasImmutableSelection ?? selectedCommits.some((c) => c.is_immutable);

        const allowAbandon = count > 0 && !containsImmutable;
        const allowMerge = count > 1;
        const allowNewBefore = count > 0 && !containsImmutable;

        let parentMutable = false;
        if (count === 1 && selectedCommits.length === 1) {
            parentMutable = canAbsorbCommit(selectedCommits[0]);
        }

        this._host.commands.setContextKey(JjContextKey.SelectionAllowAbandon, allowAbandon);
        this._host.commands.setContextKey(JjContextKey.SelectionAllowMerge, allowMerge);
        this._host.commands.setContextKey(JjContextKey.SelectionAllowNewBefore, allowNewBefore);
        this._host.commands.setContextKey(JjContextKey.SelectionParentMutable, parentMutable);
    }

    public setSelectedCommits(commitIds: readonly string[], hasImmutableSelection?: boolean): void {
        if (
            this._selectedCommitIds.length === commitIds.length &&
            this._selectedCommitIds.every((id, idx) => id === commitIds[idx])
        ) {
            this._updateSelectionContextKeys(this._selectedCommitIds, hasImmutableSelection);
            return;
        }

        this._selectedCommitIds = [...commitIds];
        this._updateSelectionContextKeys(this._selectedCommitIds, hasImmutableSelection);

        if (this._disposed) {
            return;
        }

        this._onDidChangeSelection.fire(this._selectedCommitIds);

        this._dispatcher.emitter.setSelection({ ids: [...commitIds] });
    }

    public setHiddenActions(hiddenActions: readonly string[]): void {
        const validActions = hiddenActions.filter((a): a is ToggleableCommitAction =>
            (TOGGLEABLE_COMMIT_ACTIONS as readonly string[]).includes(a),
        );

        this._hiddenActions = validActions;
        this._updateActionContextKeys();

        if (this._disposed) {
            return;
        }

        this._dispatcher.emitter.updateHiddenActions({ hiddenActions: [...validActions] });
    }

    public getHiddenActions(): string[] {
        return Array.from(this._hiddenActions);
    }

    public toggleAction(actionId: string): readonly ToggleableCommitAction[] {
        const validAction = actionId as ToggleableCommitAction;
        if (!TOGGLEABLE_COMMIT_ACTIONS.includes(validAction)) {
            return this._hiddenActions;
        }

        const next = this._hiddenActions.includes(validAction)
            ? this._hiddenActions.filter((a) => a !== validAction)
            : [...this._hiddenActions, validAction];

        this.setHiddenActions(next);
        this._host.storage.update(LogViewController.HIDDEN_ACTIONS_STORAGE_KEY, next);
        return next;
    }

    public updateConfig(config: { theme?: string; graphLabelAlignment?: string; minChangeIdLength?: number }): void {
        if (config.theme !== undefined) {
            this._theme = config.theme;
        }
        if (config.graphLabelAlignment !== undefined) {
            this._graphLabelAlignment = config.graphLabelAlignment;
        }
        if (config.minChangeIdLength !== undefined) {
            this._minChangeIdLength = config.minChangeIdLength;
        }

        if (this._disposed) {
            return;
        }

        this._dispatcher.emitter.update(this.getState());
    }

    public setTheme(theme: string): void {
        this._theme = theme;

        if (this._disposed) {
            return;
        }

        this._dispatcher.emitter.update(this.getState());
    }

    public setGraphLabelAlignment(alignment: string): void {
        this._graphLabelAlignment = alignment;

        if (this._disposed) {
            return;
        }

        this._dispatcher.emitter.update(this.getState());
    }

    public refreshSettings(): void {
        const theme = this._host.config.get<string>('logTheme', 'default');
        const alignment = this._host.config.get<string>('graphLabelAlignment', 'aligned');
        const minLength = this._host.config.get<number>('minChangeIdLength', 1);

        let changed = false;
        if (this._theme !== theme) {
            this._theme = theme;
            changed = true;
        }
        if (this._graphLabelAlignment !== alignment) {
            this._graphLabelAlignment = alignment;
            changed = true;
        }
        if (this._minChangeIdLength !== minLength) {
            this._minChangeIdLength = minLength;
            changed = true;
        }

        if (changed) {
            this.refresh('settingsChanged').catch((e) => {
                this._logger?.error('[LogViewController] Background refresh on settings change failed', toError(e));
            });
        }
    }

    public updateTheme(theme: string): void {
        this._theme = theme;
        if (this._disposed) {
            return;
        }

        this._dispatcher.emitter.update(this.getState());
    }

    public async refreshCodeForge(): Promise<void> {
        if (this._disposed || this._commits.length === 0) {
            return;
        }
        const cf = this._repo?.codeForge;
        if (!cf) {
            return;
        }

        if (!cf.isEnabled) {
            await cf.detectActiveProvider();
            return;
        }

        try {
            cf.startPolling();
            const start = performance.now();
            const hasChanges = await cf.ensureFreshStatuses(
                this._commits.map((c) => ({
                    commitId: c.commit_id ?? '',
                    changeId: c.change_id,
                    description: c.description,
                    bookmarks: c.bookmarks.filter((b) => !b.remote).map((b) => b.name),
                })),
            );

            const duration = performance.now() - start;
            this._logger?.info?.(`[LogViewController] CodeForge fetch took ${duration.toFixed(0)}ms`);

            if (hasChanges) {
                this._logger?.info?.('[LogViewController] CodeForge data changed, re-populating commits');
                this.setCommits(this._commits);
            }
        } catch (e) {
            this._logger?.error('[LogViewController] CodeForge refresh failed', toError(e));
        }
    }

    public handlePanelClosed(changeId: string): void {
        this._dispatcher.emitter.panelClosed({ changeId });
    }

    private _updateActionContextKeys(): void {
        const hiddenSet = new Set(this._hiddenActions);
        for (const actionId of TOGGLEABLE_COMMIT_ACTIONS) {
            const key = `jj.commitActionVisible.${actionId}`;
            const value = !hiddenSet.has(actionId);
            this._host.commands.setContextKey(key, value);
        }
    }

    private async executeJjMutation(
        progressTitle: string,
        failureMessage: string,
        operation: (jj: JjService) => Promise<unknown>,
    ): Promise<void> {
        const jj = this.jj;
        if (!jj) {
            return;
        }
        try {
            await this._host.ui.withProgress(progressTitle, async () => {
                await operation(jj);
            });
            await this.refresh('mutationComplete');
            await this._host.commands.executeCommand('jj-view.refresh');
        } catch (err) {
            await showJjError(this._host.ui, err, failureMessage, jj, this._logger);
        }
    }

    private _createRpcDispatcher(): WebviewRpcDispatcher<LogViewToHostMessage, LogViewHostToWebviewMessage> {
        return createWebviewRpcDispatcher<LogViewToHostMessage, LogViewHostToWebviewMessage>(
            LogViewToHostMessageSchema,
            {
                webviewLoaded: async () => {
                    await this.refresh('webviewLoaded');
                },
                openCodeForge: async (msg) => {
                    if (!msg.url) {
                        return;
                    }
                    try {
                        const parsed = new URL(msg.url);
                        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                            await this._host.nav.openExternal(Uri.parse(msg.url));
                        } else {
                            this._logger?.error(`[LogViewController] Blocked insecure scheme: ${parsed.protocol}`);
                        }
                    } catch (e) {
                        this._logger?.error(`[LogViewController] Invalid URL: ${msg.url}`, toError(e));
                    }
                },
                newChild: async (msg) => {
                    await this._host.commands.executeCommand('jj-view.new', msg);
                },
                squash: async (msg) => {
                    await this._host.commands.executeCommand('jj-view.squashRevisionIntoParent', msg);
                },
                edit: async (msg) => {
                    await this._host.commands.executeCommand('jj-view.edit', msg);
                },
                select: async (msg) => {
                    if (!this.jj) {
                        return;
                    }
                    const details = await this.jj.showDetails(msg.changeId);
                    // biome-ignore lint/suspicious/noControlCharactersInRegex: Standard regex for stripping ANSI escape codes
                    const cleanDetails = details.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
                    await this._host.commands.executeCommand('jj-view.showDetails', cleanDetails);
                },
                undo: async () => {
                    await this._host.commands.executeCommand('jj-view.undo');
                },
                redo: async () => {
                    await this._host.commands.executeCommand('jj-view.redo');
                },
                abandon: async (msg) => {
                    await this._host.commands.executeCommand('jj-view.abandon', msg);
                },
                getDetails: async (msg) => {
                    if (this._repo) {
                        await this._host.nav.openCommitDetails(
                            this._repo.rootUri,
                            msg.changeId,
                            msg.changeIdShortest,
                            msg.isDivergent,
                            msg.changeIdOffset,
                        );
                    }
                },
                new: async () => {
                    await this._host.commands.executeCommand('jj-view.new');
                },
                newBefore: async (msg) => {
                    await this._host.commands.executeCommand('jj-view.newBefore', ...(msg.changeIds || []));
                },
                newAfter: async (msg) => {
                    await this._host.commands.executeCommand('jj-view.newAfter', ...(msg.changeIds || []));
                },
                resolve: async (msg) => {
                    await this.executeJjMutation('Resolving conflict...', 'Failed to resolve conflict', async (jj) => {
                        await jj.resolve(msg.path);
                        await this._host.commands.executeCommand('jj-view.refresh');
                    });
                },
                moveBookmark: async (msg) => {
                    if (!msg.bookmark || !msg.targetChangeId) {
                        return;
                    }
                    await this.executeJjMutation('Moving bookmark...', 'Failed to move bookmark', (jj) =>
                        jj.moveBookmark(msg.bookmark, msg.targetChangeId),
                    );
                },
                rebaseCommit: async (msg) => {
                    if (!msg.sourceChangeId || !msg.targetChangeId || msg.sourceChangeId === msg.targetChangeId) {
                        return;
                    }
                    await this.executeJjMutation('Rebasing...', 'Failed to rebase', (jj) =>
                        jj.rebase(msg.sourceChangeId, msg.targetChangeId, msg.mode),
                    );
                },
                squashCommit: async (msg) => {
                    if (!msg.sourceChangeId || !msg.targetChangeId || msg.sourceChangeId === msg.targetChangeId) {
                        return;
                    }
                    const options =
                        msg.mode === 'onto'
                            ? { ontoRevision: msg.targetChangeId }
                            : { intoRevision: msg.targetChangeId };
                    await this.executeJjMutation('Squashing...', 'Failed to squash', (jj) =>
                        jj.squashRevision({ revision: msg.sourceChangeId, ...options }),
                    );
                },
                duplicateCommit: async (msg) => {
                    if (!msg.sourceChangeId || msg.sourceChangeId === msg.targetChangeId) {
                        return;
                    }
                    await this.executeJjMutation('Duplicating...', 'Failed to duplicate', (jj) =>
                        jj.duplicate(msg.sourceChangeId, msg.targetChangeId ? { onto: msg.targetChangeId } : {}),
                    );
                },
                mergeCommit: async (msg) => {
                    if (!msg.sourceChangeId || !msg.targetChangeId || msg.sourceChangeId === msg.targetChangeId) {
                        return;
                    }
                    await this.executeJjMutation('Creating merge commit...', 'Failed to create merge commit', (jj) =>
                        jj.new({ parents: [msg.sourceChangeId, msg.targetChangeId] }),
                    );
                },
                upload: async (msg) => {
                    await this._host.commands.executeCommand('jj-view.upload', msg);
                },
                showComments: async (msg) => {
                    await this._host.commands.executeCommand('jj-view.showComments', msg.changeId);
                },
                setContextKey: async (msg) => {
                    await this._host.commands.setContextKey(msg.key, msg.value);
                },
                contextMenu: async (msg) => {
                    await this._host.commands.executeCommand('jj-view.contextMenu', msg);
                },
                selectionChange: async (msg) => {
                    const count = msg.commitIds.length;
                    const hasImmutable = Boolean(msg.hasImmutableSelection);

                    if (count !== 1) {
                        const closeTabs =
                            this._options?.closeCommitDetailsTabs ??
                            this._host.nav.closeCommitDetailsTabs?.bind(this._host.nav);
                        if (closeTabs) {
                            await closeTabs((repoRoot) => {
                                if (!this._repo) {
                                    return true;
                                }
                                return !repoRoot || repoRoot.fsPath === this._repo.rootUri.fsPath;
                            });
                        }
                    }

                    this.setSelectedCommits(msg.commitIds, hasImmutable);
                    this._options?.onSelectionChange?.(msg.commitIds);
                },
            },
            {
                logger: this._logger,
                getState: () => this.getState(),
            },
        );
    }

    public dispose(): void {
        this._disposed = true;
        this._codeForgeDisposable?.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
        this._onDidUpdateCommits.dispose();
        this._onDidChangeSelection.dispose();
        this._dispatcher.dispose();
    }
}
