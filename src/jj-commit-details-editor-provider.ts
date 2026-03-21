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

    // Track all open panels for refreshing
    private readonly _panels = new Map<string, Set<vscode.WebviewPanel>>();

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
        if (document.draftDescription !== undefined) {
            await vscode.commands.executeCommand(
                'jj-view.setDescription',
                document.draftDescription,
                document.changeId,
            );
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

            const initialData = {
                view: 'details',
                payload: {
                    changeId: document.changeId,
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
            };

            panel.webview.html = this._getHtmlForWebview(panel.webview, initialData);

            panel.webview.onDidReceiveMessage(async (message) => {
                switch (message.type) {
                    case 'webviewLoaded':
                        break;
                    case 'dirtyStateChange': {
                        const isDirty = message.payload.isDirty;
                        if (isDirty) {
                            document.draftDescription = message.payload.draftDescription;
                            // Notify VS Code that the document is dirty
                            this._onDidChangeCustomDocument.fire({
                                document,
                                undo: () => {},
                                redo: () => {},
                                label: 'Edit Description',
                            });
                        }
                        break;
                    }
                    case 'saveDescription': {
                        // Natively trigger save which will call our saveCustomDocument
                        await vscode.commands.executeCommand('workbench.action.files.save');
                        panel.webview.postMessage({
                            type: 'saveComplete',
                            payload: { description: message.payload.description },
                        });
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
