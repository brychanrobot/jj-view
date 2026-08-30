/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';
import { ProcessMonitorController } from '../../core/controllers/process-monitor-controller';
import type { JjProcessTracker } from '../../core/jj-process-tracker';
import type { Uri } from '../../core/uri-utils';
import { VsCodeHostEnvironment } from '../vscode-host-environment';
import { getWebviewHtml } from '../vscode-webview-html';

export class VsCodeProcessMonitorProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'jj-view.processMonitorView';
    private readonly _disposables: vscode.Disposable[] = [];
    private _viewDisposables: vscode.Disposable[] = [];
    public readonly controller: ProcessMonitorController;

    constructor(
        private readonly _extensionUri: Uri,
        processTracker: JjProcessTracker,
        context: vscode.ExtensionContext,
    ) {
        const host = new VsCodeHostEnvironment({ context });
        this.controller = new ProcessMonitorController(processTracker, host);
    }

    public dispose(): void {
        this._clearViewDisposables();
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
        this.controller.dispose();
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._clearViewDisposables();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        this.controller.setMessenger(webviewView.webview);
        webviewView.webview.html = getWebviewHtml({
            webview: webviewView.webview,
            extensionUri: this._extensionUri,
            scriptPath: ['dist', 'webview', 'process-monitor.js'],
            title: 'JJ Process Monitor',
        });

        this._viewDisposables.push(
            webviewView.onDidDispose(() => {
                this.controller.setMessenger(undefined);
                this._clearViewDisposables();
            }),
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    this.controller.updateWebview();
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
}
