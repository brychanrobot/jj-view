/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from './jj-service';
import { JjContextKey } from './jj-context-keys';
import { JjLogEntry } from './jj-types';
import { shortenChangeId } from './utils/jj-utils';
import { JjCommitDetailsEditorProvider } from './jj-commit-details-editor-provider';

import { GerritService } from './gerrit-service';

export class JjLogWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'jj-view.logView';
    private _view?: vscode.WebviewView;
    private _cachedCommits: JjLogEntry[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _jj: JjService,
        private readonly _gerrit: GerritService,
        private readonly _commitDetailsProvider: JjCommitDetailsEditorProvider,
        private readonly _onSelectionChange: (commits: string[]) => void,
        public readonly outputChannel?: vscode.OutputChannel, // Optional
    ) {
        // Gerrit updates only need to re-render, not re-fetch jj log
        this._gerrit.onDidUpdate(() => this.refreshGerrit());

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('jj-view.logTheme') || e.affectsConfiguration('jj-view.graphLabelAlignment')) {
                this._renderCommits(this._cachedCommits);
            }
        });
    }

    public get jj(): JjService {
        return this._jj;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        // Update the HTML when the view becomes hidden so that when it is restored,
        // it uses the latest cached data instead of the initial stale data.
        webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) {
                const config = vscode.workspace.getConfiguration('jj-view');
                const currentTheme = config.get<string>('logTheme', 'default');
                const graphLabelAlignment = config.get<string>('graphLabelAlignment', 'aligned');
                webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, {
                    view: 'graph',
                    payload: {
                        commits: this._cachedCommits,
                        theme: currentTheme,
                        graphLabelAlignment,
                    },
                });
            }
        });

        const config = vscode.workspace.getConfiguration('jj-view');
        const initialTheme = config.get<string>('logTheme', 'default');
        const graphLabelAlignment = config.get<string>('graphLabelAlignment', 'aligned');
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, {
            view: 'graph',
            payload: {
                commits: this._cachedCommits,
                theme: initialTheme,
                graphLabelAlignment,
            },
        });

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'webviewLoaded':
                    await this.refresh();
                    break;
                case 'openGerrit':
                    if (data.payload.url) {
                        await vscode.env.openExternal(vscode.Uri.parse(data.payload.url));
                    }
                    break;
                case 'newChild':
                    // new(message?, parent?)
                    await vscode.commands.executeCommand('jj-view.new', data.payload);
                    break;
                case 'squash':
                    // Route through extension command to reuse safe squash logic (editor, etc.)
                    // Pass the whole payload
                    await vscode.commands.executeCommand('jj-view.squash', data.payload);
                    // Refresh is handled by the command event listener
                    break;
                case 'edit':
                    await vscode.commands.executeCommand('jj-view.edit', data.payload);
                    break;
                case 'select':
                    const details = await this._jj.showDetails(data.payload.changeId);
                    const cleanDetails = details.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
                    vscode.workspace.openTextDocument({ content: cleanDetails, language: 'plaintext' }).then((doc) =>
                        vscode.window.showTextDocument(doc, {
                            preview: true,
                            viewColumn: vscode.ViewColumn.Beside,
                        }),
                    );
                    break;
                case 'undo':
                    await vscode.commands.executeCommand('jj-view.undo');
                    break;
                case 'abandon':
                    await vscode.commands.executeCommand('jj-view.abandon', data.payload);
                    break;
                case 'getDetails':
                    await this.createCommitDetailsPanel(data.payload.changeId);
                    break;
                case 'new':
                    await vscode.commands.executeCommand('jj-view.new');
                    break;
                case 'newBefore':
                    await vscode.commands.executeCommand('jj-view.newBefore', ...(data.payload.changeIds || []));
                    break;
                case 'newAfter':
                    await vscode.commands.executeCommand('jj-view.newAfter', ...(data.payload.changeIds || []));
                    break;
                case 'resolve':
                    await this._jj.resolve(data.payload);
                    await vscode.commands.executeCommand('jj-view.refresh');
                    break;
                case 'moveBookmark':
                    await this._jj.moveBookmark(data.payload.bookmark, data.payload.targetChangeId);
                    await vscode.commands.executeCommand('jj-view.refresh');
                    break;
                case 'rebaseCommit':
                    await this._jj.rebase(data.payload.sourceChangeId, data.payload.targetChangeId, data.payload.mode);
                    await vscode.commands.executeCommand('jj-view.refresh');
                    break;
                case 'upload':
                    await vscode.commands.executeCommand('jj-view.upload', data.payload);
                    break;
                case 'selectionChange': {
                    const count = data.payload.commitIds.length;
                    const hasImmutable = !!data.payload.hasImmutableSelection;

                    if (count !== 1) {
                        const tabsToClose: vscode.Tab[] = [];
                        for (const tabGroup of vscode.window.tabGroups.all) {
                            for (const tab of tabGroup.tabs) {
                                if (
                                    tab.input instanceof vscode.TabInputCustom &&
                                    tab.input.viewType === JjCommitDetailsEditorProvider.viewType
                                ) {
                                    tabsToClose.push(tab);
                                }
                            }
                        }
                        if (tabsToClose.length > 0) {
                            await vscode.window.tabGroups.close(tabsToClose);
                        }
                    }

                    // Compute Capabilities
                    const allowAbandon = count > 0 && !hasImmutable;
                    const allowMerge = count > 1;
                    const allowNewBefore = count > 0 && !hasImmutable;

                    // Calculate parent mutability for absorb command
                    // Only applicable for single selection where parents are mutable
                    let parentMutable = false;
                    if (count === 1) {
                        const selectedCommit = this._cachedCommits.find(
                            (c) => c.change_id === data.payload.commitIds[0],
                        );
                        if (selectedCommit && selectedCommit.parents_immutable) {
                            // If any parent is NOT immutable (i.e. is mutable), then we can absorb
                            parentMutable = selectedCommit.parents_immutable.some((immutable) => !immutable);
                        } else if (selectedCommit) {
                            parentMutable = false;
                        }
                    }

                    vscode.commands.executeCommand('setContext', JjContextKey.SelectionAllowAbandon, allowAbandon);
                    vscode.commands.executeCommand('setContext', JjContextKey.SelectionAllowMerge, allowMerge);
                    vscode.commands.executeCommand('setContext', JjContextKey.SelectionAllowNewBefore, allowNewBefore);
                    vscode.commands.executeCommand('setContext', JjContextKey.SelectionParentMutable, parentMutable);

                    if (this._onSelectionChange) {
                        this._onSelectionChange(data.payload.commitIds);
                    }
                    break;
                }
            }
        });
    }

    public async refresh() {
        if (this._view) {
            const start = performance.now();
            let commits: JjLogEntry[] = [];

            try {
                this.outputChannel?.appendLine(`[JjLogWebviewProvider] Refreshing...`);

                // Default jj log (usually local heads/roots)
                const logStart = performance.now();
                commits = await this._jj.getLog({ omitChanges: true });
                const logDuration = performance.now() - logStart;
                this.outputChannel?.appendLine(
                    `[JjLogWebviewProvider] jj log took ${logDuration.toFixed(0)}ms, found ${commits.length} commits`,
                );

                this._cachedCommits = commits;
                this._renderCommits(commits);

                const initialRenderDuration = performance.now() - start;
                this.outputChannel?.appendLine(
                    `[JjLogWebviewProvider] Initial render took ${initialRenderDuration.toFixed(0)}ms`,
                );
            } catch (e) {
                this.outputChannel?.appendLine(`[JjLogWebviewProvider] Failed to fetch log: ${e}`);
                return;
            }

            // Background fetch Gerrit status for commits
            await this.refreshGerrit();

            // Also refresh details panel if open
            await this._commitDetailsProvider.refresh();
        }
    }

    /** Re-fetch Gerrit data for cached commits and re-render. */
    private async refreshGerrit() {
        if (!this._view || this._cachedCommits.length === 0) return;
        if (!this._gerrit.isEnabled) return;

        try {
            this._gerrit.startPolling();

            const gerritStart = performance.now();
            const hasChanges = await this._gerrit.ensureFreshStatuses(
                this._cachedCommits.map((c) => ({
                    commitId: c.commit_id ?? '',
                    changeId: c.change_id,
                    description: c.description,
                })),
            );

            const gerritDuration = performance.now() - gerritStart;
            this.outputChannel?.appendLine(`[JjLogWebviewProvider] Gerrit fetch took ${gerritDuration.toFixed(0)}ms`);

            if (hasChanges) {
                this.outputChannel?.appendLine('[JjLogWebviewProvider] Gerrit data changed, re-rendering');
                this._renderCommits(this._cachedCommits);
            }
        } catch (e) {
            this.outputChannel?.appendLine(`[JjLogWebviewProvider] Gerrit refresh failed: ${e}`);
        }
    }

    private _renderCommits(commits: JjLogEntry[]) {
        const config = vscode.workspace.getConfiguration('jj-view');
        const minChangeIdLength = config.get<number>('minChangeIdLength', 1);
        const logTheme = config.get<string>('logTheme', 'default');
        const graphLabelAlignment = config.get<string>('graphLabelAlignment', 'aligned');

        if (this._gerrit.isEnabled) {
            this._gerrit.populateGerritInfo(commits);
        } else {
            this.outputChannel?.appendLine('[JjLogWebviewProvider] Gerrit service is disabled.');
        }

        this._view?.webview.postMessage({
            type: 'update',
            commits,
            minChangeIdLength,
            theme: logTheme,
            graphLabelAlignment,
        });
    }

    public async createCommitDetailsPanel(changeId: string) {
        const config = vscode.workspace.getConfiguration('jj-view');
        const minChangeIdLength = config.get<number>('minChangeIdLength', 1);
        const shortId = shortenChangeId(changeId, minChangeIdLength);
        const uri = vscode.Uri.from({
            scheme: 'jj-commit',
            authority: 'commit',
            path: `/Commit: ${shortId}`,
            query: `changeId=${changeId}`,
        });

        const tabsToClose: vscode.Tab[] = [];
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                if (
                    tab.input instanceof vscode.TabInputCustom &&
                    tab.input.viewType === JjCommitDetailsEditorProvider.viewType
                ) {
                    if (tab.input.uri.toString() !== uri.toString()) {
                        tabsToClose.push(tab);
                    }
                }
            }
        }
        if (tabsToClose.length > 0) {
            await vscode.window.tabGroups.close(tabsToClose);
        }

        await vscode.commands.executeCommand('vscode.openWith', uri, JjCommitDetailsEditorProvider.viewType);
    }

    private _getHtmlForWebview(webview: vscode.Webview, initialData?: unknown) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'index.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'codicons', 'codicon.css'),
        );

        const nonce = getNonce();
        const initialDataScript = initialData ? `window.vscodeInitialData = ${JSON.stringify(initialData)};` : '';

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
                <link href="${styleUri}" rel="stylesheet">
                <link href="${codiconsUri}" rel="stylesheet">
                <title>JJ Log</title>
            </head>
            <body>
                <div id="root"></div>
                <script nonce="${nonce}">
                    ${initialDataScript}
                </script>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
