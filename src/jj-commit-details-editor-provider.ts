/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { WebviewToHostMessageSchema } from './common/ipc-schemas';
import { createWebviewRpcDispatcher } from './common/webview-rpc-dispatcher';
import { createJjResourceState } from './scm-resource-state';
import { getUriParams, Uri } from './uri-utils';
import { getJjViewConfig } from './utils/config-utils';
import { formatCommitTitle } from './utils/jj-utils';

export class JjCommitDocument implements vscode.CustomDocument {
    public readonly uri: Uri;
    public readonly changeId: string;
    public readonly repoRoot?: Uri;
    public draftDescription?: string;
    public persistedDescription?: string;

    constructor(uri: Uri, changeId: string, repoRoot?: Uri) {
        this.uri = uri;
        this.changeId = changeId;
        this.repoRoot = repoRoot;
    }

    dispose(): void {}
}

export class JjCommitDetailsEditorProvider implements vscode.CustomEditorProvider<JjCommitDocument> {
    public static readonly viewType = 'jj-view.commitDetailsEditor';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
        vscode.CustomDocumentEditEvent<JjCommitDocument>
    >();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    private readonly _onDidClosePanel = new vscode.EventEmitter<string>();
    public readonly onDidClosePanel = this._onDidClosePanel.event;

    // Track all open panels for refreshing
    private readonly _panels = new Map<string, Set<vscode.WebviewPanel>>();

    // Track the last state pushed to the undo stack per document to avoid redundant edits
    // and to provide a base for the next undo/redo pair.
    private readonly _documentStates = new Map<
        string,
        {
            lastPushedText: string;
            lastPushedSelection: { start: number; end: number };
            debounceTimer?: NodeJS.Timeout;
            pendingUpdate?: { newText: string; newSelection: { start: number; end: number } };
            panel: vscode.WebviewPanel;
            document: JjCommitDocument;
        }
    >();

    constructor(
        private readonly _extensionUri: Uri,
        private readonly _repositoryManager: import('./jj-repository-manager').JjRepositoryManager,
    ) {}

    private getRepositoryForRoot(repoRoot?: Uri) {
        return repoRoot
            ? this._repositoryManager.getRepositoryForUri(repoRoot)
            : this._repositoryManager.focusedRepository;
    }
    public async refresh(_reason?: string): Promise<void> {
        for (const [changeId, panels] of this._panels.entries()) {
            if (panels.size === 0) {
                continue;
            }

            try {
                const state = this._documentStates.get(changeId);
                const repo = this.getRepositoryForRoot(state?.document.repoRoot);
                if (!repo) {
                    this._repositoryManager.outputChannel.info(
                        `[JjCommitDetailsEditorProvider.refresh] No Jujutsu repository resolved for changeId ${changeId}`,
                    );
                    continue;
                }

                const scope = state?.document.repoRoot;
                const minChangeIdLength = getJjViewConfig<number>('minChangeIdLength', 1, scope) ?? 1;
                const logTheme = getJjViewConfig<string>('logTheme', 'default', scope) ?? 'default';
                const titleWidthRuler = getJjViewConfig<number>('commit.titleWidthRuler', undefined, scope);
                const bodyWidthRuler = getJjViewConfig<number>('commit.bodyWidthRuler', undefined, scope);
                const formatDescriptionOnSave =
                    getJjViewConfig<boolean>('commit.formatDescriptionOnSave', false, scope) ?? false;

                const logPromise = repo.jj.getLog({ revision: changeId });
                const changesPromise = repo.jj.getChanges(changeId).catch(() => null);

                const logs = await logPromise;
                if (logs.length === 0) {
                    panels.forEach((p) => {
                        p.dispose();
                    });
                    continue;
                }

                const log = logs[0];
                const rawFilesWithStats = await changesPromise;
                const filesWithStats = rawFilesWithStats || log.changes || [];

                for (const panel of panels) {
                    panel.webview.postMessage({
                        type: 'updateDetails',
                        payload: {
                            changeId,
                            commitId: log.commit_id,
                            description: (log.description || '').trim(),
                            files: filesWithStats,
                            isImmutable: log.is_immutable,
                            author: log.author,
                            committer: log.committer,
                            bookmarks: log.bookmarks || [],
                            tags: log.tags || [],
                            isEmpty: log.is_empty,
                            isConflict: log.conflict,
                            minChangeIdLength,
                            theme: logTheme,
                            titleWidthRuler,
                            bodyWidthRuler,
                            formatDescriptionOnSave,
                        },
                    });
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                if (errMsg.includes("doesn't exist") || errMsg.includes('does not exist')) {
                    panels.forEach((p) => {
                        try {
                            p.dispose();
                        } catch {
                            // Ignore if already disposed
                        }
                    });
                }
            }
        }
    }

    public async saveCustomDocument(
        document: JjCommitDocument,
        _cancellation: vscode.CancellationToken,
    ): Promise<void> {
        // Ensure any pending typing is pushed to the undo stack before saving
        // so that the saved state is correctly marked as 'clean'.
        this._flushDebounce(document.changeId);

        if (document.draftDescription !== undefined) {
            // Check if this is a 'soft save' (text already matches what's on disk)
            const isSoftSave = document.draftDescription === document.persistedDescription;

            if (!isSoftSave) {
                const formattedDescription = await vscode.commands.executeCommand<string | boolean>(
                    'jj-view.setDescription',
                    document.draftDescription,
                    document.changeId,
                );

                // Update persisted state after successful real save
                if (typeof formattedDescription === 'string') {
                    document.draftDescription = formattedDescription;
                    document.persistedDescription = formattedDescription;
                } else {
                    document.persistedDescription = document.draftDescription;
                }
            }

            // Sync all panels for this changeId to mark them as clean
            const panels = this._panels.get(document.changeId);
            if (panels) {
                for (const panel of panels) {
                    panel.webview.postMessage({
                        type: 'saveComplete',
                        payload: { description: document.draftDescription },
                    });
                }
            }
        }
    }

    public async saveCustomDocumentAs(
        _document: JjCommitDocument,
        _destination: Uri,
        _cancellation: vscode.CancellationToken,
    ): Promise<void> {
        // Not applicable for this editor
        await this.saveCustomDocument(_document, _cancellation);
    }

    public async revertCustomDocument(
        _document: JjCommitDocument,
        _cancellation: vscode.CancellationToken,
    ): Promise<void> {
        // We handle reversion by telling the webview to reload the data.
        // It's easiest to just leave it as is or trigger a refresh command.
    }

    public backupCustomDocument(
        document: JjCommitDocument,
        _context: vscode.CustomDocumentBackupContext,
        _cancellation: vscode.CancellationToken,
    ): Promise<vscode.CustomDocumentBackup> {
        // CustomEditor requires a backup implementation to truly support hot-exit, but we can provide a dummy for now.
        return Promise.resolve({
            id: document.uri.toString(),
            delete: () => {},
        });
    }

    public async openCustomDocument(
        uri: Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken,
    ): Promise<JjCommitDocument> {
        // URI format: jj-commit://commit/Commit:%20<shortId>#changeId=<changeId>&repoRoot=<repoRoot>
        const urlParams = getUriParams(uri);
        const changeId = urlParams.get('changeId') || '';
        const repoRootPath = urlParams.get('repoRoot');
        const repoRoot = repoRootPath ? Uri.file(repoRootPath) : undefined;
        return new JjCommitDocument(uri, changeId, repoRoot);
    }

    public async resolveCustomEditor(
        document: JjCommitDocument,
        panel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        // Track the panel
        if (!this._panels.has(document.changeId)) {
            this._panels.set(document.changeId, new Set());
        }
        this._panels.get(document.changeId)?.add(panel);

        panel.onDidDispose(() => {
            this._panels.get(document.changeId)?.delete(panel);
            if (this._panels.get(document.changeId)?.size === 0) {
                this._panels.delete(document.changeId);
                this._documentStates.delete(document.changeId);
                this._onDidClosePanel.fire(document.changeId);
            }
        });

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
            enableCommandUris: true,
        };

        const scope = document.repoRoot;
        const minChangeIdLength = getJjViewConfig<number>('minChangeIdLength', 1, scope) ?? 1;
        const logTheme = getJjViewConfig<string>('logTheme', 'default', scope) ?? 'default';
        const titleWidthRuler = getJjViewConfig<number>('commit.titleWidthRuler', undefined, scope);
        const bodyWidthRuler = getJjViewConfig<number>('commit.bodyWidthRuler', undefined, scope);
        const formatDescriptionOnSave =
            getJjViewConfig<boolean>('commit.formatDescriptionOnSave', false, scope) ?? false;
        const repo = this.getRepositoryForRoot(document.repoRoot);
        if (!repo) {
            this._repositoryManager.outputChannel.info(
                `[JjCommitDetailsEditorProvider.resolveCustomEditor] No Jujutsu repository resolved for document: ${document.uri.toString()} (repoRoot: ${document.repoRoot?.fsPath})`,
            );
            panel.dispose();
            return;
        }

        try {
            const logPromise = repo.jj.getLog({ revision: document.changeId });
            const changesPromise = repo.jj.getChanges(document.changeId).catch(() => null);

            const logs = await logPromise;
            if (logs.length === 0) {
                panel.dispose();
                return;
            }

            const log = logs[0];
            const rawFilesWithStats = await changesPromise;
            const filesWithStats = rawFilesWithStats || log.changes || [];

            const initialDescription = (log.description || '').trim();
            const initialData = {
                view: 'details',
                payload: {
                    changeId: document.changeId,
                    commitId: log.commit_id,
                    description: initialDescription,
                    files: filesWithStats,
                    isImmutable: log.is_immutable,
                    author: log.author,
                    committer: log.committer,
                    bookmarks: log.bookmarks || [],
                    tags: log.tags || [],
                    isEmpty: log.is_empty,
                    isConflict: log.conflict,
                    minChangeIdLength,
                    theme: logTheme,
                    titleWidthRuler,
                    bodyWidthRuler,
                    formatDescriptionOnSave,
                },
            };

            panel.webview.html = this._getHtmlForWebview(panel.webview, initialData);

            // Seed document with its initial persisted state
            document.persistedDescription = initialDescription;
            document.draftDescription = initialDescription;

            const dispatcher = createWebviewRpcDispatcher(
                WebviewToHostMessageSchema,
                {
                    webviewLoaded: async () => {},
                    descriptionChanged: async (msg) => {
                        const newText = msg.payload.description;
                        const newSelection = {
                            start: msg.payload.selectionStart ?? 0,
                            end: msg.payload.selectionEnd ?? 0,
                        };

                        document.draftDescription = newText;

                        let state = this._documentStates.get(document.changeId);
                        if (!state) {
                            state = {
                                lastPushedText: document.persistedDescription || '',
                                lastPushedSelection: { start: 0, end: 0 },
                                panel,
                                document,
                            };
                            this._documentStates.set(document.changeId, state);
                        } else {
                            state.panel = panel;
                        }

                        if (state.debounceTimer) {
                            clearTimeout(state.debounceTimer);
                        }

                        state.pendingUpdate = { newText, newSelection };
                        state.debounceTimer = setTimeout(() => {
                            this._flushDebounce(document.changeId);
                        }, 200);
                    },
                    saveDescription: async (msg) => {
                        const newText = msg.payload.description;
                        document.draftDescription = newText;
                        this._flushDebounce(document.changeId);
                        await vscode.commands.executeCommand('workbench.action.files.save');
                    },
                    openDiff: async (msg) => {
                        const { file, changeId, isImmutable } = msg.payload;
                        const state = createJjResourceState(file, changeId, repo.jj.workspaceRoot, {
                            editable: !isImmutable,
                            openDiffOnClick: true,
                        });

                        if (state.command) {
                            await vscode.commands.executeCommand(
                                state.command.command,
                                ...(state.command.arguments ?? []),
                            );
                        }
                    },
                    openMultiDiff: async (msg) => {
                        await vscode.commands.executeCommand('jj-view.showMultiFileDiff', msg.payload.changeId);
                    },
                },
                {
                    messenger: panel.webview,
                },
            );

            panel.webview.onDidReceiveMessage(async (message) => {
                return await dispatcher.dispatch(message);
            });
        } catch (_) {
            panel.dispose();
        }
    }

    private _flushDebounce(changeId: string) {
        const state = this._documentStates.get(changeId);
        if (!state?.pendingUpdate) {
            return;
        }

        if (state.debounceTimer) {
            clearTimeout(state.debounceTimer);
            state.debounceTimer = undefined;
        }

        const { newText, newSelection } = state.pendingUpdate;
        state.pendingUpdate = undefined;

        if (newText === state.lastPushedText) {
            return;
        }

        const oldText = state.lastPushedText;
        const oldSelection = state.lastPushedSelection;

        const { document } = state;

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {
                const s = this._documentStates.get(changeId);
                if (s) {
                    s.lastPushedText = oldText;
                    s.lastPushedSelection = oldSelection;
                }
                state.panel.webview.postMessage({
                    type: 'updateDescription',
                    payload: {
                        description: oldText,
                        selectionStart: oldSelection.start,
                        selectionEnd: oldSelection.end,
                    },
                });
            },
            redo: () => {
                const s = this._documentStates.get(changeId);
                if (s) {
                    s.lastPushedText = newText;
                    s.lastPushedSelection = newSelection;
                }
                state.panel.webview.postMessage({
                    type: 'updateDescription',
                    payload: {
                        description: newText,
                        selectionStart: newSelection.start,
                        selectionEnd: newSelection.end,
                    },
                });
            },
            label: 'Edit Description',
        });

        state.lastPushedText = newText;
        state.lastPushedSelection = newSelection;

        // Stealth Save: If we just returned to the original persisted text,
        // trigger a no-op save to clear the dirty indicator on the tab.
        if (newText === document.persistedDescription) {
            vscode.commands.executeCommand('workbench.action.files.save');
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview, initialData?: unknown) {
        const scriptUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'dist', 'webview', 'index.js'));
        const styleUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'media', 'main.css'));
        const codiconsUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'media', 'codicons', 'codicon.css'));

        let nonceText = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            nonceText += possible.charAt(Math.floor(Math.random() * possible.length));
        }

        const initialDataScript = initialData ? `window.vscodeInitialData = ${JSON.stringify(initialData)};` : '';

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonceText}' ${webview.cspSource};">
                <link href="${styleUri}" rel="stylesheet">
                <link href="${codiconsUri}" rel="stylesheet">
                <title>JJ Log</title>
            </head>
            <body>
                <div id="root"></div>
                <script nonce="${nonceText}">
                    ${initialDataScript}
                </script>
                <script nonce="${nonceText}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

/**
 * Shared utility to open the commit details editor tab and manage active tabs.
 */
export async function openCommitDetails(
    workspaceRoot: string,
    changeId: string,
    changeIdShortest?: string,
    isDivergent?: boolean,
    changeIdOffset?: number,
): Promise<void> {
    const minChangeIdLength = getJjViewConfig<number>('minChangeIdLength', 1) ?? 1;
    const title = formatCommitTitle(
        {
            change_id: changeId,
            change_id_shortest: changeIdShortest,
            is_divergent: isDivergent,
            change_id_offset: changeIdOffset,
        },
        minChangeIdLength,
    );

    const uri = Uri.from({
        scheme: 'jj-commit',
        authority: 'commit',
        path: `/${title}`,
        fragment: `changeId=${changeId}&repoRoot=${encodeURIComponent(workspaceRoot)}`,
    });

    await closeOtherCommitDetailsTabs(uri, workspaceRoot);

    await vscode.commands.executeCommand('vscode.openWith', uri, JjCommitDetailsEditorProvider.viewType);
}

export async function closeOtherCommitDetailsTabs(currentUri: Uri, workspaceRoot: string | undefined): Promise<void> {
    const allTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const tabsToClose = allTabs.filter((tab) => {
        if (!(tab.input instanceof vscode.TabInputCustom)) {
            return false;
        }
        if (tab.input.viewType !== JjCommitDetailsEditorProvider.viewType) {
            return false;
        }
        if (tab.input.uri.toString() === currentUri.toString()) {
            return false;
        }

        try {
            const query = getUriParams(tab.input.uri);
            const tabRepoRoot = query.get('repoRoot');
            return !tabRepoRoot || tabRepoRoot === workspaceRoot;
        } catch {
            return true; // Default to closing if parsing fails
        }
    });

    if (tabsToClose.length > 0) {
        await vscode.window.tabGroups.close(tabsToClose);
    }
}
