/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { toError } from '../../utils/error-utils';
import type { LoggerChannel } from '../../utils/output-channel';
import { type Disposable, type Event, EventEmitter } from '../host/events';
import type { HostEnvironment } from '../host/host-environment';
import {
    type CommitDetailsHostToWebviewMessage,
    type CommitDetailsPayload,
    type CommitDetailsToHostMessage,
    CommitDetailsToHostMessageSchema,
} from '../host/ipc/commit-details-schemas';
import { showJjError } from '../host/ui-helpers';
import {
    createWebviewRpcReceiver,
    type WebviewPostMessageLike,
    type WebviewRpcReceiver,
} from '../host/webview-rpc-dispatcher';
import type { JjRepository } from '../jj-repository';
import type { JjLogEntry, JjStatusEntry } from '../jj-types';

export interface CommitDetailsControllerOptions {
    logger?: LoggerChannel;
    onEditRecorded?: (edit: { undo: () => void; redo: () => void; label: string }) => void;
    openDiff?: (payload: { file: JjStatusEntry; changeId: string; isImmutable?: boolean }) => Promise<void> | void;
}

export class CommitDetailsController implements Disposable {
    private _disposed = false;
    private readonly _disposables: Disposable[] = [];
    private _loadVersion = 0;
    private readonly _logger?: LoggerChannel;
    private readonly _receiver: WebviewRpcReceiver<CommitDetailsToHostMessage, CommitDetailsHostToWebviewMessage>;

    private _logEntry?: JjLogEntry;
    private _changes?: readonly JjStatusEntry[];
    private _draftDescription?: string;
    private _persistedDescription?: string;

    private _lastPushedText = '';
    private _lastPushedSelection = { start: 0, end: 0 };
    private _debounceTimer?: NodeJS.Timeout;
    private _pendingUpdate?: { newText: string; newSelection: { start: number; end: number } };

    private readonly _onDidUpdate = new EventEmitter<JjLogEntry>();
    public readonly onDidUpdate: Event<JjLogEntry> = this._onDidUpdate.event;

    private readonly _onDidClose = new EventEmitter<string>();
    public readonly onDidClose: Event<string> = this._onDidClose.event;

    constructor(
        public readonly changeId: string,
        public readonly repo: JjRepository | undefined,
        private readonly _host: HostEnvironment,
        private readonly _options?: CommitDetailsControllerOptions,
    ) {
        this._logger = _options?.logger;
        this._receiver = this._createRpcReceiver();
    }

    public get logEntry(): JjLogEntry | undefined {
        return this._logEntry;
    }

    public get changes(): readonly JjStatusEntry[] | undefined {
        return this._changes;
    }

    public get draftDescription(): string {
        return this._draftDescription ?? this._logEntry?.description ?? '';
    }

    public get persistedDescription(): string | undefined {
        return this._persistedDescription;
    }

    public getState(): CommitDetailsPayload | undefined {
        if (!this._logEntry) {
            return undefined;
        }
        return {
            changeId: this.changeId,
            commitId: this._logEntry.commit_id,
            description: (this._draftDescription ?? this._logEntry.description ?? '').trim(),
            files: this._changes ? [...this._changes] : [],
            isImmutable: this._logEntry.is_immutable,
            author: this._logEntry.author,
            committer: this._logEntry.committer,
            bookmarks: this._logEntry.bookmarks || [],
            tags: this._logEntry.tags || [],
            isEmpty: this._logEntry.is_empty,
            isConflict: this._logEntry.conflict,
            minChangeIdLength: this._host.config.get<number>('minChangeIdLength', 1),
            theme: this._host.config.get<string>('logTheme', 'default'),
            titleWidthRuler: this._host.config.get<number | undefined>('commit.titleWidthRuler'),
            bodyWidthRuler: this._host.config.get<number | undefined>('commit.bodyWidthRuler'),
            formatDescriptionOnSave: this._host.config.get<boolean>('commit.formatDescriptionOnSave', false),
        };
    }

    public addMessenger(messenger: WebviewPostMessageLike): Disposable {
        const sub = this._receiver.addMessenger(messenger);
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                sub.dispose();
                if (!this._receiver.hasMessengers) {
                    this._onDidClose.fire(this.changeId);
                }
            },
        };
    }

    public async handleMessage(rawMessage: unknown): Promise<boolean> {
        if (this._disposed) {
            return false;
        }
        return this._receiver.dispatch(rawMessage);
    }

    public async load(): Promise<JjLogEntry | undefined> {
        if (!this.repo || this._disposed) {
            return undefined;
        }

        const currentVersion = ++this._loadVersion;
        try {
            const logsPromise = this.repo.jj.getLog({ revision: this.changeId });
            const changesPromise = this.repo.jj.getChanges(this.changeId).catch(() => null);

            const [logs, rawChanges] = await Promise.all([logsPromise, changesPromise]);

            if (currentVersion !== this._loadVersion || this._disposed) {
                return undefined;
            }

            if (logs.length === 0) {
                this._logger?.info?.(`[CommitDetailsController] Commit ${this.changeId} not found/deleted`);
                this._onDidClose.fire(this.changeId);
                return undefined;
            }

            const log = logs[0];
            const changes = rawChanges || log.changes || [];

            this._logEntry = log;
            this._changes = changes;
            const previousPersisted = this._persistedDescription;
            const freshPersisted = (log.description || '').trim();
            const wasDirty = this._draftDescription !== undefined && this._draftDescription !== previousPersisted;
            this._persistedDescription = freshPersisted;

            if (!wasDirty) {
                this._draftDescription = freshPersisted;
                this._lastPushedText = freshPersisted;
            }

            this._onDidUpdate.fire(log);

            const state = this.getState();
            if (state) {
                this._receiver.sender.update(state);
            }
            return log;
        } catch (err) {
            this._logger?.error(
                `[CommitDetailsController] Failed to load commit details for ${this.changeId}`,
                toError(err),
            );
            return undefined;
        }
    }

    public updateDraft(newText: string, selection: { start: number; end: number } = { start: 0, end: 0 }): void {
        if (this._disposed) {
            return;
        }
        this._draftDescription = newText;

        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }

        this._pendingUpdate = { newText, newSelection: selection };
        this._debounceTimer = setTimeout(() => {
            this.flushDebounce();
        }, 200);
    }

    public flushDebounce(): void {
        if (!this._pendingUpdate) {
            return;
        }

        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = undefined;
        }

        const { newText, newSelection } = this._pendingUpdate;
        this._pendingUpdate = undefined;

        if (newText === this._lastPushedText) {
            return;
        }

        const oldText = this._lastPushedText;
        const oldSelection = this._lastPushedSelection;

        this._options?.onEditRecorded?.({
            label: 'Edit Description',
            undo: () => {
                this.applyUndoRedo(oldText, oldSelection);
            },
            redo: () => {
                this.applyUndoRedo(newText, newSelection);
            },
        });

        this._lastPushedText = newText;
        this._lastPushedSelection = newSelection;

        if (newText === this._persistedDescription) {
            this._host.commands.executeCommand('workbench.action.files.save');
        }
    }

    public applyUndoRedo(text: string, selection: { start: number; end: number }): void {
        if (this._disposed) {
            return;
        }
        this.flushDebounce();
        this._lastPushedText = text;
        this._lastPushedSelection = selection;
        this._draftDescription = text;

        this._receiver.sender.updateDescription({
            description: text,
            selectionStart: selection.start,
            selectionEnd: selection.end,
        });
    }

    public async save(finalDescription?: string): Promise<boolean> {
        if (this._disposed) {
            return false;
        }
        this.flushDebounce();

        const descriptionToSave = finalDescription ?? this._draftDescription ?? this._logEntry?.description ?? '';
        const isSoftSave = descriptionToSave === this._persistedDescription;
        try {
            let savedDescription = descriptionToSave;
            if (!isSoftSave) {
                const res = await this._host.commands.executeCommand(
                    'jj-view.setDescription',
                    descriptionToSave,
                    this.changeId,
                );
                if (typeof res === 'string') {
                    savedDescription = res;
                } else if (res === false) {
                    return false;
                } else if (this.repo) {
                    await this.repo.jj.describe(descriptionToSave, this.changeId);
                    await this._host.commands.executeCommand('jj-view.refresh');
                }
            }

            if (this._logEntry) {
                this._logEntry = {
                    ...this._logEntry,
                    description: savedDescription,
                };
            }
            this._draftDescription = savedDescription;
            this._persistedDescription = savedDescription;

            this._receiver.sender.saveComplete({
                description: savedDescription,
            });
            return true;
        } catch (err) {
            this._logger?.error(`[CommitDetailsController] Failed to save commit ${this.changeId}`, toError(err));
            this._receiver.sender.saveFailed();
            await showJjError(this._host.ui, err, 'Failed to save commit description', this.repo?.jj, this._logger);
            return false;
        }
    }

    private _createRpcReceiver(): WebviewRpcReceiver<CommitDetailsToHostMessage, CommitDetailsHostToWebviewMessage> {
        return createWebviewRpcReceiver<CommitDetailsToHostMessage, CommitDetailsHostToWebviewMessage>(
            CommitDetailsToHostMessageSchema,
            {
                descriptionChanged: async (payload) => {
                    const newText = payload.description;
                    const newSelection = {
                        start: payload.selectionStart ?? 0,
                        end: payload.selectionEnd ?? 0,
                    };
                    this.updateDraft(newText, newSelection);
                },
                saveDescription: async (payload) => {
                    const newText = payload.description;
                    this._draftDescription = newText;
                    this.flushDebounce();
                    await this._host.commands.executeCommand('workbench.action.files.save');
                },
                openDiff: async (payload) => {
                    const { file, changeId, isImmutable } = payload;
                    if (this._options?.openDiff) {
                        await this._options.openDiff({ file, changeId, isImmutable });
                    }
                },
                openMultiDiff: async (payload) => {
                    await this._host.commands.executeCommand('jj-view.showMultiFileDiff', payload.changeId);
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
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = undefined;
        }
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
        this._onDidUpdate.dispose();
        this._onDidClose.dispose();
        this._receiver.dispose();
    }
}
