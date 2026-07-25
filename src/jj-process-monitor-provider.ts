/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { JjProcessTask, JjProcessTracker } from './jj-process-tracker';
import { getTaskExitCode } from './jj-process-tracker';
import { CoalescingQueue } from './utils/coalescing-queue';

export class JjProcessMonitorProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'jj-view.processMonitorView';
    private _view?: vscode.WebviewView;
    private readonly _disposables: vscode.Disposable[] = [];
    private _viewDisposables: vscode.Disposable[] = [];
    private readonly _updateQueue = new CoalescingQueue(async () => {
        this._doUpdateWebview();
    });

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _processTracker: JjProcessTracker,
    ) {
        this._disposables.push(
            this._processTracker.onDidChangeProcesses(() => {
                this._updateWebview();
            }),
        );
    }

    public dispose(): void {
        this._view = undefined;
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
        for (const d of this._viewDisposables) {
            d.dispose();
        }
        this._viewDisposables.length = 0;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        for (const d of this._viewDisposables) {
            d.dispose();
        }
        this._viewDisposables = [];
        this._view = webviewView;

        this._viewDisposables.push(
            webviewView.onDidDispose(() => {
                this._view = undefined;
                for (const d of this._viewDisposables) {
                    d.dispose();
                }
                this._viewDisposables = [];
            }),
        );

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        this._viewDisposables.push(
            webviewView.webview.onDidReceiveMessage((message: unknown) => {
                if (typeof message !== 'object' || message === null || !('command' in message)) {
                    return;
                }
                const msg = message as { command: string; id?: unknown };
                switch (msg.command) {
                    case 'killProcess':
                        if (typeof msg.id === 'number') {
                            this._processTracker.cancelProcess(msg.id);
                        }
                        break;
                    case 'killAllProcesses':
                        this._processTracker.cancelAllProcesses();
                        break;
                    case 'clearHistory':
                        this._processTracker.clearHistory();
                        break;
                    case 'hidePanel':
                        vscode.workspace
                            .getConfiguration('jj-view')
                            .update('showProcessMonitorPanel', false, vscode.ConfigurationTarget.Global);
                        break;
                }
            }),
        );

        this._viewDisposables.push(
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    this._updateWebview();
                }
            }),
        );

        this._updateWebview();
    }

    private _updateWebview(): void {
        if (!this._view?.visible) {
            return;
        }
        this._updateQueue.run();
    }

    private _doUpdateWebview(): void {
        if (!this._view?.visible) {
            return;
        }

        const activeTasks = this._processTracker.getActiveTasks().map((t: JjProcessTask) => ({
            id: t.id,
            command: t.command,
            args: t.args,
            startPerformanceTime: t.startPerformanceTime,
            timestamp: t.timestamp ?? Date.now(),
            label: t.label ?? '',
            pid: t.childProcess.pid ?? 0,
        }));

        const historyTasks = this._processTracker.getHistory().map((t: JjProcessTask) => ({
            id: t.id,
            command: t.command,
            args: t.args,
            duration: t.duration ?? 0,
            status: t.status,
            label: t.label ?? '',
            error: t.error ?? '',
            stdout: t.stdout ?? '',
            stderr: t.stderr ?? '',
            exitCode: getTaskExitCode(t),
            timestamp: t.timestamp ?? Date.now(),
        }));

        const metrics = this._processTracker.getMetrics();

        this._view.webview.postMessage({
            type: 'update',
            activeTasks,
            historyTasks,
            metrics,
            now: performance.now(),
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'process-monitor.js'),
        );
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
    <link href="${styleUri}" rel="stylesheet">
    <title>JJ Process Monitor</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
