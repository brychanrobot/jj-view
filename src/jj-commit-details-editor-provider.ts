/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { JjService } from './jj-service';
import { createDiffUris } from './uri-utils';
import { shortenChangeId } from './utils/jj-utils';

export class JjCommitDocument implements vscode.CustomDocument {
    public readonly uri: vscode.Uri;
    public readonly changeId: string;
    public draftDescription?: string;
    public persistedDescription?: string;

    constructor(uri: vscode.Uri, changeId: string) {
        this.uri = uri;
        this.changeId = changeId;
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
        private readonly _extensionUri: vscode.Uri,
        private readonly _jj: JjService,
    ) {}

    public async refresh(): Promise<void> {
        const config = vscode.workspace.getConfiguration('jj-view');
        const minChangeIdLength = config.get<number>('minChangeIdLength', 1);
        const logTheme = config.get<string>('logTheme', 'default');
        const titleWidthRuler = config.get<number>('commit.titleWidthRuler');
        const bodyWidthRuler = config.get<number>('commit.bodyWidthRuler');

        for (const [changeId, panels] of this._panels.entries()) {
            if (panels.size === 0) continue;

            try {
                const logs = await this._jj.getLog({ revision: changeId });
                if (logs.length === 0) {
                    panels.forEach((p) => p.dispose());
                    continue;
                }

                const log = logs[0];
                const filesWithStats = await this._jj.getChanges(changeId).catch(() => log.changes || []);

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
                        },
                    });
                }
            } catch (e) {
                // Ignore errors for individual refreshes
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
                await vscode.commands.executeCommand(
                    'jj-view.setDescription',
                    document.draftDescription,
                    document.changeId,
                );

                // Update persisted state after successful real save
                document.persistedDescription = document.draftDescription;
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
        _destination: vscode.Uri,
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
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken,
    ): Promise<JjCommitDocument> {
        // URI format: jj-commit://commit/Commit:%20<shortId>?changeId=<changeId>
        const query = new URLSearchParams(uri.query);
        const changeId = query.get('changeId') || uri.path.split('/').pop() || uri.path;
        return new JjCommitDocument(uri, changeId);
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
        this._panels.get(document.changeId)!.add(panel);

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

        const config = vscode.workspace.getConfiguration('jj-view');
        const minChangeIdLength = config.get<number>('minChangeIdLength', 1);
        const logTheme = config.get<string>('logTheme', 'default');
        const titleWidthRuler = config.get<number>('commit.titleWidthRuler');
        const bodyWidthRuler = config.get<number>('commit.bodyWidthRuler');

        try {
            const logs = await this._jj.getLog({ revision: document.changeId });
            if (logs.length === 0) {
                panel.dispose();
                return;
            }

            const log = logs[0];
            const filesWithStats = await this._jj.getChanges(document.changeId).catch(() => log.changes || []);

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
                },
            };

            panel.webview.html = this._getHtmlForWebview(panel.webview, initialData);

            // Seed document with its initial persisted state
            document.persistedDescription = initialDescription;
            document.draftDescription = initialDescription;

            panel.webview.onDidReceiveMessage(async (message) => {
                switch (message.type) {
                    case 'webviewLoaded':
                        break;
                    case 'descriptionChanged': {
                        const newText = message.payload.description;
                        const newSelection = {
                            start: message.payload.selectionStart,
                            end: message.payload.selectionEnd,
                        };

                        // Update current document state immediately so 'Save' always has latest
                        document.draftDescription = newText;

                        // Debounce the undo stack push so typing doesn't create thousands of undo points.
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
                            // Update the panel reference so flush uses the latest active panel
                            state.panel = panel;
                        }

                        if (state.debounceTimer) {
                            clearTimeout(state.debounceTimer);
                        }

                        state.pendingUpdate = { newText, newSelection };
                        state.debounceTimer = setTimeout(() => {
                            this._flushDebounce(document.changeId);
                        }, 200);
                        break;
                    }
                    case 'saveDescription': {
                        const newText = message.payload.description;
                        document.draftDescription = newText;

                        // Flush any pending undo history so it remains 'behind' the save point
                        this._flushDebounce(document.changeId);

                        // Natively trigger save which will call our saveCustomDocument
                        await vscode.commands.executeCommand('workbench.action.files.save');
                        break;
                    }
                    case 'openDiff': {
                        const file = message.payload.file;
                        const changeId = message.payload.changeId;
                        const isImmutable = message.payload.isImmutable;

                        const { leftUri, rightUri } = createDiffUris(file, changeId, this._jj.workspaceRoot, {
                            editable: !isImmutable,
                        });

                        await vscode.commands.executeCommand(
                            'vscode.diff',
                            leftUri,
                            rightUri,
                            `${path.basename(file.path)} (${shortenChangeId(changeId, minChangeIdLength)})${!isImmutable ? ' (Editable)' : ''}`,
                        );
                        break;
                    }
                    case 'openMultiDiff':
                        await vscode.commands.executeCommand('jj-view.showMultiFileDiff', message.payload.changeId);
                        break;
                }
            });
        } catch (e) {
            panel.dispose();
        }
    }

    private _flushDebounce(changeId: string) {
        const state = this._documentStates.get(changeId);
        if (!state || !state.pendingUpdate) return;

        if (state.debounceTimer) {
            clearTimeout(state.debounceTimer);
            state.debounceTimer = undefined;
        }

        const { newText, newSelection } = state.pendingUpdate;
        state.pendingUpdate = undefined;

        if (newText === state.lastPushedText) return;

        const oldText = state.lastPushedText;
        const oldSelection = state.lastPushedSelection;

        const document = state.document;

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
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'index.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'codicons', 'codicon.css'),
        );

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
