/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { CommitDetailsController } from '../../controllers/commit-details-controller';
import type { JjRepositoryManager } from '../../jj-repository-manager';
import { createJjResourceState } from '../../scm-resource-state';
import { parseCommitDetailsUri, type Uri } from '../../uri-utils';
import { VsCodeHostEnvironment } from '../vscode-host-environment';
import { getWebviewHtml } from '../vscode-webview-html';

export class JjCommitDocument implements vscode.CustomDocument {
    public readonly uri: Uri;
    public readonly changeId: string;
    public readonly repoRoot?: Uri;

    constructor(uri: Uri, changeId: string, repoRoot?: Uri) {
        this.uri = uri;
        this.changeId = changeId;
        this.repoRoot = repoRoot;
    }

    dispose(): void {}
}

export class VsCodeCommitDetailsEditorProvider
    implements vscode.CustomEditorProvider<JjCommitDocument>, vscode.Disposable
{
    public static readonly viewType = 'jj-view.commitDetailsEditor';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
        vscode.CustomDocumentEditEvent<JjCommitDocument>
    >();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    private readonly _onDidClosePanel = new vscode.EventEmitter<string>();
    public readonly onDidClosePanel = this._onDidClosePanel.event;

    private readonly _controllers = new Map<string, CommitDetailsController>();
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _extensionUri: Uri,
        private readonly _repositoryManager: JjRepositoryManager,
        private readonly _context: vscode.ExtensionContext,
    ) {}

    public getController(changeId: string): CommitDetailsController | undefined {
        return this._controllers.get(changeId);
    }

    public async refresh(changeId?: string): Promise<void> {
        if (changeId && this._controllers.has(changeId)) {
            const controller = this._controllers.get(changeId);
            if (controller) {
                await controller.load();
            }
            return;
        }

        for (const controller of this._controllers.values()) {
            await controller.load();
        }
    }

    public async saveCustomDocument(
        document: JjCommitDocument,
        _cancellation: vscode.CancellationToken,
    ): Promise<void> {
        const controller = this._controllers.get(document.changeId);
        if (controller) {
            await controller.save();
        }
    }

    public async saveCustomDocumentAs(
        document: JjCommitDocument,
        _destination: Uri,
        cancellation: vscode.CancellationToken,
    ): Promise<void> {
        await this.saveCustomDocument(document, cancellation);
    }

    public async revertCustomDocument(
        _document: JjCommitDocument,
        _cancellation: vscode.CancellationToken,
    ): Promise<void> {}

    public backupCustomDocument(
        document: JjCommitDocument,
        _context: vscode.CustomDocumentBackupContext,
        _cancellation: vscode.CancellationToken,
    ): Promise<vscode.CustomDocumentBackup> {
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
        const { changeId, repoRoot } = parseCommitDetailsUri(uri);
        return new JjCommitDocument(uri, changeId, repoRoot);
    }

    public async resolveCustomEditor(
        document: JjCommitDocument,
        panel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        const repo = document.repoRoot
            ? this._repositoryManager.getRepositoryForUri(document.repoRoot)
            : this._repositoryManager.focusedRepository;
        if (!repo) {
            this._repositoryManager.outputChannel.info(
                `[VsCodeCommitDetailsEditorProvider.resolveCustomEditor] No Jujutsu repository resolved for document: ${document.uri.toString()} (repoRoot: ${document.repoRoot?.fsPath})`,
            );
            panel.dispose();
            return;
        }

        const host = new VsCodeHostEnvironment({
            context: this._context,
        });

        let controller = this._controllers.get(document.changeId);
        if (!controller) {
            const newController = new CommitDetailsController(document.changeId, repo, host, {
                logger: this._repositoryManager.outputChannel,
                onEditRecorded: (edit) => {
                    this._onDidChangeCustomDocument.fire({
                        document,
                        undo: edit.undo,
                        redo: edit.redo,
                        label: edit.label,
                    });
                },
                openDiff: async (payload) => {
                    const state = createJjResourceState(payload.file, payload.changeId, repo.jj.workspaceRoot, {
                        editable: !payload.isImmutable,
                        openDiffOnClick: true,
                    });
                    if (state.command) {
                        await vscode.commands.executeCommand(state.command.command, ...(state.command.arguments ?? []));
                    }
                },
            });
            this._controllers.set(document.changeId, newController);
            controller = newController;

            newController.onDidClose(() => {
                this._controllers.delete(document.changeId);
                this._onDidClosePanel.fire(document.changeId);
                newController.dispose();
            });
        }

        const log = await controller.load();
        if (!log) {
            this._controllers.delete(document.changeId);
            controller.dispose();
            panel.dispose();
            return;
        }

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
            enableCommandUris: true,
        };

        const messageDisposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
            await controller.handleMessage(message);
        });
        const messengerDisposable = controller.addMessenger(panel.webview);

        const panelDisposables: vscode.Disposable[] = [messageDisposable, messengerDisposable];
        panel.onDidDispose(() => {
            for (const d of panelDisposables) {
                d.dispose();
            }
        });

        panel.webview.html = getWebviewHtml({
            webview: panel.webview,
            extensionUri: this._extensionUri,
            scriptPath: ['dist', 'webview', 'commit-details.js'],
            title: 'Commit Details',
        });
    }

    public dispose(): void {
        for (const controller of this._controllers.values()) {
            controller.dispose();
        }
        this._controllers.clear();
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
        this._onDidChangeCustomDocument.dispose();
        this._onDidClosePanel.dispose();
    }
}
