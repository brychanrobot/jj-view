/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type * as vscode from 'vscode';
import { LogViewController } from '../../core/controllers/log-view-controller';
import type { JjRepository } from '../../core/jj-repository';
import type { Uri } from '../../core/uri-utils';
import type { LoggerChannel } from '../../utils/output-channel';
import { VsCodeHostEnvironment } from '../vscode-host-environment';
import { getWebviewHtml } from '../vscode-webview-html';

export class VsCodeLogWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'jj-view.logView';
    private _view?: vscode.WebviewView;
    private readonly _disposables: vscode.Disposable[] = [];
    private _viewDisposables: vscode.Disposable[] = [];

    public readonly controller: LogViewController;
    public readonly outputChannel?: LoggerChannel;

    constructor(
        private readonly _extensionUri: Uri,
        initialRepo: JjRepository | undefined,
        onSelectionChange: (commits: string[]) => void,
        context: vscode.ExtensionContext,
        outputChannel?: LoggerChannel,
    ) {
        this.outputChannel = outputChannel;

        const host = new VsCodeHostEnvironment({
            context,
        });

        this.controller = new LogViewController(initialRepo, host, {
            logger: outputChannel,
            onSelectionChange,
        });
    }

    public get repository(): JjRepository | undefined {
        return this.controller.repository;
    }

    public async updateRepository(repo: JjRepository | undefined): Promise<void> {
        this.controller.repository = repo;
        this._updateTitle();
    }

    private _updateTitle(): void {
        if (this._view) {
            if (this.controller.repository) {
                const folderName = path.basename(this.controller.repository.rootUri.fsPath);
                this._view.title = `JJ Log (${folderName})`;
            } else {
                this._view.title = 'JJ Log';
            }
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._clearViewDisposables();
        this._view = webviewView;
        this._updateTitle();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        this.controller.setMessenger(webviewView.webview);

        const initialHtml = this._getHtmlForWebview(webviewView.webview);
        webviewView.webview.html = initialHtml;

        this._viewDisposables.push(
            webviewView.onDidDispose(() => {
                this._view = undefined;
                this.controller.setMessenger(undefined);
                this._clearViewDisposables();
            }),
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    this.controller.setCommits(this.controller.commits);
                    this.controller.refresh('becameVisible').catch((e) => {
                        this.outputChannel?.error(`[VsCodeLogWebviewProvider] Visibility refresh error: ${e}`);
                    });
                }
            }),
            webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
                return await this.controller.handleMessage(message);
            }),
        );
    }

    private _clearViewDisposables(): void {
        for (const d of this._viewDisposables) {
            d.dispose();
        }
        this._viewDisposables = [];
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return getWebviewHtml({
            webview,
            extensionUri: this._extensionUri,
            scriptPath: ['dist', 'webview', 'index.js'],
            title: 'JJ Log',
        });
    }

    public dispose(): void {
        this._clearViewDisposables();
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
        this.controller.dispose();
    }
}
