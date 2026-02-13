/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { JjService } from './jj-service';
import { JjContextKey } from './jj-context-keys';
import { JjLogEntry } from './jj-types';

import { GerritService } from './gerrit-service';

export class JjLogWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'jj-view.logView';
    private _view?: vscode.WebviewView;
    private _cachedCommits: JjLogEntry[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _jj: JjService,
        private readonly _gerrit: GerritService,
        private readonly _onSelectionChange: (commits: string[]) => void,
        private readonly _outputChannel?: vscode.OutputChannel // Optional
    ) {
        // Gerrit updates only need to re-render, not re-fetch jj log
        this._gerrit.onDidUpdate(() => this.refreshGerrit());
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
                 webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, {
                    view: 'graph',
                    payload: {
                        commits: this._cachedCommits,
                    },
                });
            }
        });

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, {
            view: 'graph',
            payload: {
                commits: this._cachedCommits,
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
                    await vscode.commands.executeCommand('jj-view.new', data.payload.commitId);
                    break;
                case 'squash':
                    // Route through extension command to reuse safe squash logic (editor, etc.)
                    // Pass the commitId string to the squash command
                    await vscode.commands.executeCommand('jj-view.squash', data.payload.commitId);
                    // Refresh is handled by the command event listener
                    break;
                case 'edit':
                    await vscode.commands.executeCommand('jj-view.edit', data.payload.commitId);
                    break;
                case 'select':
                    const details = await this._jj.showDetails(data.payload.commitId);
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
                    await this.createCommitDetailsPanel(data.payload.commitId);
                    break;
                case 'new':
                    await vscode.commands.executeCommand('jj-view.new');
                    break;
                case 'newBefore':
                    await vscode.commands.executeCommand('jj-view.newBefore', ...(data.payload.commitIds || []));
                    break;
                case 'resolve':
                    await this._jj.resolve(data.payload);
                    await vscode.commands.executeCommand('jj-view.refresh');
                    break;
                case 'moveBookmark':
                    await this._jj.moveBookmark(data.payload.bookmark, data.payload.targetCommitId);
                    await vscode.commands.executeCommand('jj-view.refresh');
                    break;
                case 'rebaseCommit':
                    await this._jj.rebase(data.payload.sourceCommitId, data.payload.targetCommitId, data.payload.mode);
                    await vscode.commands.executeCommand('jj-view.refresh');
                    break;
                case 'upload':
                    await vscode.commands.executeCommand('jj-view.upload', data.payload.commitId);
                    break;
                case 'selectionChange':
                    if (data.payload.commitIds.length === 0 && this._activeDetailsPanel) {
                        // Close details panel if selection is cleared
                        // Must clear reference first to avoid loop with onDidDispose
                        const panel = this._activeDetailsPanel;
                        this._activeDetailsPanel = undefined;
                        panel.dispose();
                    }

                    const count = data.payload.commitIds.length;
                    const hasImmutable = !!data.payload.hasImmutableSelection;

                    // Compute Capabilities
                    const allowAbandon = count > 0 && !hasImmutable;
                    const allowMerge = count > 1;
                    const allowNewBefore = count > 0 && !hasImmutable;

                    // Calculate parent mutability for absorb command
                    // Only applicable for single selection where parents are mutable
                    let parentMutable = false;
                    if (count === 1) {
                        const selectedCommit = this._cachedCommits.find((c) => c.change_id === data.payload.commitIds[0]);
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
        });
    }

    public async refresh() {
        if (this._view) {
            const start = performance.now();
            let commits: JjLogEntry[] = [];
            
            try {
                this._outputChannel?.appendLine(`[JjLogWebviewProvider] Refreshing...`);
                // Default jj log (usually local heads/roots)
                const logStart = performance.now();
                commits = await this._jj.getLog({});
                const logDuration = performance.now() - logStart;
                this._outputChannel?.appendLine(`[JjLogWebviewProvider] jj log took ${logDuration.toFixed(0)}ms`);

                this._cachedCommits = commits;
                this._renderCommits(commits);
                
                const initialRenderDuration = performance.now() - start;
                this._outputChannel?.appendLine(`[JjLogWebviewProvider] Initial render took ${initialRenderDuration.toFixed(0)}ms`);
            } catch (e) {
                this._outputChannel?.appendLine(`[JjLogWebviewProvider] Failed to fetch log: ${e}`);
                return;
            }

            // Background fetch Gerrit status for commits
            await this.refreshGerrit();
        }
    }

    /** Re-fetch Gerrit data for cached commits and re-render. */
    private async refreshGerrit() {
        if (!this._view || this._cachedCommits.length === 0) return;
        if (!this._gerrit.isEnabled) return;
        
        try {
            this._gerrit.startPolling();
            
            const gerritStart = performance.now();
            const hasChanges = await this._gerrit.ensureFreshStatuses(this._cachedCommits.map(c => ({
                commitId: c.commit_id ?? '',
                changeId: c.change_id,
                description: c.description
            })));

            const gerritDuration = performance.now() - gerritStart;
            this._outputChannel?.appendLine(`[JjLogWebviewProvider] Gerrit fetch took ${gerritDuration.toFixed(0)}ms`);

            if (hasChanges) {
                this._outputChannel?.appendLine('[JjLogWebviewProvider] Gerrit data changed, re-rendering');
                this._renderCommits(this._cachedCommits);
            }
        } catch (e) {
            this._outputChannel?.appendLine(`[JjLogWebviewProvider] Gerrit refresh failed: ${e}`);
        }
    }

    private _renderCommits(commits: JjLogEntry[]) {
        if (this._gerrit.isEnabled) {
            for (const commit of commits) {
                if (commit.commit_id) {
                    commit.gerritCl = this._gerrit.getCachedClStatus(
                        commit.change_id,
                        commit.description
                    );
                }
            }
        } else {
            this._outputChannel?.appendLine('[JjLogWebviewProvider] Gerrit service is disabled.');
        }
        
        this._view?.webview.postMessage({
            type: 'update', commits
        });
    }

    private _activeDetailsPanel?: vscode.WebviewPanel;

    public async createCommitDetailsPanel(commitId: string) {
        const description = await this._jj.getDescription(commitId);
        const changes = await this._jj.getChanges(commitId);

        const initialData = {
            view: 'details',
            payload: {
                commitId,
                description,
                files: changes,
            },
        };

        if (this._activeDetailsPanel) {
            this._activeDetailsPanel.title = `Commit: ${commitId.substring(0, 8)}`;
            this._activeDetailsPanel.webview.html = this._getHtmlForWebview(
                this._activeDetailsPanel.webview,
                initialData,
            );
            this._activeDetailsPanel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'jj-view.commitDetails',
            `Commit: ${commitId.substring(0, 8)}`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                localResourceRoots: [this._extensionUri],
            },
        );
        this._activeDetailsPanel = panel;

        panel.webview.html = this._getHtmlForWebview(panel.webview, initialData);

        panel.onDidDispose(() => {
            if (this._activeDetailsPanel === panel) {
                this._activeDetailsPanel = undefined;
                // Notify graph view to clear selection
                if (this._view) {
                    this._view.webview.postMessage({ type: 'setSelection', ids: [] });
                }
            }
        });

        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'webviewLoaded':
                    // Panel handles its own state via initialData
                    break;
                case 'saveDescription':
                    await vscode.commands.executeCommand(
                        'jj-view.setDescription',
                        message.payload.description,
                        message.payload.commitId,
                    );
                    vscode.window.showInformationMessage('Description updated');
                    break;
                case 'openDiff':
                    const filePath = message.payload.filePath;
                    // Left: Parent (commitId-)
                    // Right: Commit (commitId)
                    // We use our custom scheme which JjDocumentContentProvider handles
                    const parentUri = vscode.Uri.parse(`jj-view:${filePath}?revision=${commitId}-`);
                    const childUri = vscode.Uri.parse(`jj-view:${filePath}?revision=${commitId}`);

                    await vscode.commands.executeCommand(
                        'vscode.diff',
                        parentUri,
                        childUri,
                        `${path.basename(filePath)} (${commitId.substring(0, 8)})`,
                    );
                    break;
            }
        });
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
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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
