/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import type * as vscode from 'vscode';
import { Uri } from '../core/uri-utils';

const cssContentCache = new Map<string, string>();

export function clearCssCache(): void {
    cssContentCache.clear();
    cachedCodiconRules = undefined;
}

export function prewarmWebviewCssCache(extensionUri: Uri): void {
    const mainCssPath = Uri.joinPath(extensionUri, 'media', 'main.css').fsPath;
    const themesCssPath = Uri.joinPath(extensionUri, 'media', 'themes.generated.css').fsPath;
    const codiconsCssPath = Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css').fsPath;
    const commitDetailsCssPath = Uri.joinPath(extensionUri, 'dist', 'webview', 'commit-details.css').fsPath;

    readCachedCss(mainCssPath);
    readCachedCss(themesCssPath);
    getCachedCodiconRules(codiconsCssPath);
    readCachedCss(commitDetailsCssPath);
}

function readCachedCss(filePath: string): string {
    const cached = cssContentCache.get(filePath);
    if (cached !== undefined) {
        return cached;
    }
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        cssContentCache.set(filePath, content);
        return content;
    } catch {
        return '';
    }
}

let cachedCodiconRules: string | undefined;

function getCachedCodiconRules(filePath: string): string {
    if (cachedCodiconRules !== undefined) {
        return cachedCodiconRules;
    }
    const raw = readCachedCss(filePath);
    cachedCodiconRules = raw.replace(/@font-face\s*\{[^}]*\}\s*/g, '').trim();
    return cachedCodiconRules;
}

export interface WebviewHtmlOptions {
    webview: vscode.Webview;
    extensionUri: Uri;
    scriptPath: readonly string[];
    title: string;
    initialData?: unknown;
    initialHtml?: string;
}

export function safeJsonStringify(data: unknown): string {
    return JSON.stringify(data).replace(/[<>/&\u2028\u2029]/g, (char) => {
        switch (char) {
            case '<':
                return '\\u003c';
            case '>':
                return '\\u003e';
            case '/':
                return '\\u002f';
            case '&':
                return '\\u0026';
            case '\u2028':
                return '\\u2028';
            case '\u2029':
                return '\\u2029';
            default:
                return char;
        }
    });
}

export function getWebviewHtml(options: WebviewHtmlOptions): string {
    const { webview, extensionUri, scriptPath, title, initialData, initialHtml } = options;
    const scriptUri = webview.asWebviewUri(Uri.joinPath(extensionUri, ...scriptPath));
    const codiconTtfUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.ttf'));

    const mainCssPath = Uri.joinPath(extensionUri, 'media', 'main.css').fsPath;
    const themesCssPath = Uri.joinPath(extensionUri, 'media', 'themes.generated.css').fsPath;
    const codiconsCssPath = Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css').fsPath;

    const inlinedMainCss = readCachedCss(mainCssPath);
    const inlinedThemesCss = readCachedCss(themesCssPath);
    const inlinedCodiconRules = getCachedCodiconRules(codiconsCssPath);

    const lastScriptSegment = scriptPath[scriptPath.length - 1] ?? '';
    const companionCssSegment = lastScriptSegment.endsWith('.js')
        ? lastScriptSegment.replace(/\.js$/, '.css')
        : `${lastScriptSegment}.css`;
    const companionCssPath = Uri.joinPath(extensionUri, ...scriptPath.slice(0, -1), companionCssSegment).fsPath;
    const inlinedCompanionCss = readCachedCss(companionCssPath);

    const nonce = getNonce();
    const initialStateScript =
        initialData !== undefined
            ? `<script type="application/json" id="__INITIAL_STATE__" nonce="${nonce}">${safeJsonStringify(initialData)}</script>`
            : '';

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
            <link rel="preload" href="${codiconTtfUri}" as="font" type="font/truetype" crossorigin>
            <style>
                html, body {
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    margin: 0;
                    padding: 0;
                    height: 100%;
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                }
                #root {
                    height: 100%;
                }
                @font-face {
                    font-family: "codicon";
                    font-display: block;
                    src: url("${codiconTtfUri}") format("truetype");
                }
                ${inlinedCodiconRules}
                ${inlinedMainCss}
                ${inlinedThemesCss}
                ${inlinedCompanionCss}
            </style>
            <title>${title}</title>
        </head>
        <body>
            <div id="root">${initialHtml ?? ''}</div>
            ${initialStateScript}
            <script nonce="${nonce}" src="${scriptUri}" defer></script>
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
