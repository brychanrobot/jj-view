/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';
import { Uri } from '../core/uri-utils';

export interface WebviewHtmlOptions {
    webview: vscode.Webview;
    extensionUri: Uri;
    scriptPath: readonly string[];
    title: string;
}

export function getWebviewHtml(options: WebviewHtmlOptions): string {
    const { webview, extensionUri, scriptPath, title } = options;
    const scriptUri = webview.asWebviewUri(Uri.joinPath(extensionUri, ...scriptPath));
    const styleUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'main.css'));
    const themesUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'themes.generated.css'));
    const codiconsUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css'));

    const nonce = getNonce();

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
            <link href="${styleUri}" rel="stylesheet">
            <link href="${themesUri}" rel="stylesheet">
            <link href="${codiconsUri}" rel="stylesheet">
            <title>${title}</title>
        </head>
        <body>
            <div id="root"></div>
            <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
        </html>`;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
