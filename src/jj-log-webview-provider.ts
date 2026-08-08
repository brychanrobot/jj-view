/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CodeForgeService } from './code-forge-service';
import { showJjError, withDelayedProgress } from './commands/command-utils';
import { WebviewToHostMessageSchema } from './common/ipc-schemas';
import { createWebviewRpcDispatcher } from './common/webview-rpc-dispatcher';
import { JjCommitDetailsEditorProvider, openCommitDetails } from './jj-commit-details-editor-provider';
import { JjContextKey } from './jj-context-keys';
import type { JjRepository } from './jj-repository';
import type { JjService } from './jj-service';
import { type JjLogEntry, TOGGLEABLE_COMMIT_ACTIONS, type ToggleableCommitAction } from './jj-types';
import { getUriParams, Uri } from './uri-utils';
import { getJjViewConfig } from './utils/config-utils';
import { canAbsorbCommit } from './utils/jj-utils';
import type { JjLoggerChannel } from './utils/output-channel';

export class JjLogWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'jj-view.logView';
    private _view?: vscode.WebviewView;
    private _cachedCommits: JjLogEntry[] = [];
    private readonly _hiddenActionsKey = 'jj-view.hiddenCommitActions';

    private _repo: JjRepository | undefined;
    private _codeForgeDisposable: vscode.Disposable | undefined;
    private readonly _onSelectionChange: (commits: string[]) => void;
    private readonly _context: vscode.ExtensionContext;
    public readonly outputChannel?: JjLoggerChannel;

    constructor(
        extensionUri: Uri,
        initialRepo: JjRepository | undefined,
        onSelectionChange: (commits: string[]) => void,
        context: vscode.ExtensionContext,
        outputChannel?: JjLoggerChannel,
    );
    constructor(
        extensionUri: Uri,
        initialRepo: JjRepository | undefined,
        commitDetailsProvider: JjCommitDetailsEditorProvider,
        onSelectionChange: (commits: string[]) => void,
        context: vscode.ExtensionContext,
        outputChannel?: JjLoggerChannel,
    );
    constructor(
        private readonly _extensionUri: Uri,
        initialRepo: JjRepository | undefined,
        arg3: JjCommitDetailsEditorProvider | ((commits: string[]) => void),
        arg4?: ((commits: string[]) => void) | vscode.ExtensionContext,
        arg5?: vscode.ExtensionContext | JjLoggerChannel,
        outputChannel?: JjLoggerChannel,
    ) {
        this._repo = initialRepo;

        let onSelectionChange: (commits: string[]) => void;
        let context: vscode.ExtensionContext;
        let finalOutputChannel: JjLoggerChannel | undefined;

        if (typeof arg3 === 'function') {
            onSelectionChange = arg3;
            context = arg4 as vscode.ExtensionContext;
            finalOutputChannel = arg5 as JjLoggerChannel;
        } else {
            onSelectionChange = arg4 as (commits: string[]) => void;
            context = arg5 as vscode.ExtensionContext;
            finalOutputChannel = outputChannel;
        }

        this._onSelectionChange = onSelectionChange;
        this._context = context;
        this.outputChannel = finalOutputChannel;

        // Code forge updates only need to re-render, not re-fetch jj log
        const cf = this._codeForge;
        if (cf) {
            this._codeForgeDisposable = cf.onDidUpdate(() => this.refreshCodeForge());
        }

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('jj-view.logTheme') || e.affectsConfiguration('jj-view.graphLabelAlignment')) {
                this._renderCommits(this._cachedCommits);
            }
        });

        this._updateContextKeys();
    }

    public handlePanelClosed(changeId: string) {
        this._view?.webview.postMessage({
            type: 'panelClosed',
            payload: { changeId },
        });
    }

    public get repository(): JjRepository | undefined {
        return this._repo;
    }

    public get jj(): JjService | undefined {
        return this._repo?.jj;
    }

    private get _codeForge(): CodeForgeService | undefined {
        return this._repo?.codeForge;
    }

    public async updateRepository(repo: JjRepository | undefined) {
        if (this._repo?.rootUri.fsPath === repo?.rootUri.fsPath) {
            return;
        }
        this._repo = repo;
        this._codeForgeDisposable?.dispose();
        const cf = this._codeForge;
        if (cf) {
            this._codeForgeDisposable = cf.onDidUpdate(() => this.refreshCodeForge());
            cf.detectActiveProvider(true).catch((e) =>
                this.outputChannel?.error(`[JjLogWebviewProvider] Code forge detection failed: ${e}`),
            );
        }
        this._updateTitle();
        await this.refresh('repoChanged');
    }

    private _updateTitle() {
        if (this._view) {
            if (this._repo) {
                const folderName = path.basename(this._repo.rootUri.fsPath);
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
    ) {
        this._view = webviewView;
        this._updateTitle();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        // Update the HTML when the view becomes hidden so that when it is restored,
        // it uses the latest cached data instead of the initial stale data.
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.outputChannel?.info('[JjLogWebviewProvider] View became visible, re-rendering');
                this._renderCommits(this._cachedCommits);
            } else {
                const currentTheme = getJjViewConfig<string>('logTheme', 'default') ?? 'default';
                const graphLabelAlignment = getJjViewConfig<string>('graphLabelAlignment', 'aligned') ?? 'aligned';
                const hiddenActions = this._getHiddenActions();
                webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, {
                    view: 'graph',
                    payload: {
                        commits: this._cachedCommits,
                        theme: currentTheme,
                        graphLabelAlignment,
                        hiddenActions,
                    },
                });
            }
        });

        const initialTheme = getJjViewConfig<string>('logTheme', 'default') ?? 'default';
        const graphLabelAlignment = getJjViewConfig<string>('graphLabelAlignment', 'aligned') ?? 'aligned';
        const hiddenActions = this._getHiddenActions();
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, {
            view: 'graph',
            payload: {
                commits: this._cachedCommits,
                theme: initialTheme,
                graphLabelAlignment,
                hiddenActions,
            },
        });

        const dispatcher = createWebviewRpcDispatcher(
            WebviewToHostMessageSchema,
            {
                webviewLoaded: async () => {
                    await this.refresh();
                },
                openCodeForge: async (msg) => {
                    if (msg.payload.url) {
                        await vscode.env.openExternal(Uri.parse(msg.payload.url));
                    }
                },
                newChild: async (msg) => {
                    await vscode.commands.executeCommand('jj-view.new', msg.payload);
                },
                squash: async (msg) => {
                    await vscode.commands.executeCommand('jj-view.squashRevisionIntoParent', msg.payload);
                },
                edit: async (msg) => {
                    await vscode.commands.executeCommand('jj-view.edit', msg.payload);
                },
                select: async (msg) => {
                    if (!this.jj) {
                        return;
                    }
                    const details = await this.jj.showDetails(msg.payload.changeId);
                    // biome-ignore lint/suspicious/noControlCharactersInRegex: Standard regex for stripping ANSI escape codes
                    const cleanDetails = details.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
                    const doc = await vscode.workspace.openTextDocument({
                        content: cleanDetails,
                        language: 'plaintext',
                    });
                    await vscode.window.showTextDocument(doc, {
                        preview: true,
                        viewColumn: vscode.ViewColumn.Beside,
                    });
                },
                undo: async () => {
                    await vscode.commands.executeCommand('jj-view.undo');
                },
                redo: async () => {
                    await vscode.commands.executeCommand('jj-view.redo');
                },
                abandon: async (msg) => {
                    await vscode.commands.executeCommand('jj-view.abandon', msg.payload);
                },
                getDetails: async (msg) => {
                    await this.createCommitDetailsPanel(
                        msg.payload.changeId,
                        msg.payload.changeIdShortest,
                        msg.payload.isDivergent,
                        msg.payload.changeIdOffset,
                    );
                },
                new: async () => {
                    await vscode.commands.executeCommand('jj-view.new');
                },
                newBefore: async (msg) => {
                    await vscode.commands.executeCommand('jj-view.newBefore', ...(msg.payload.changeIds || []));
                },
                newAfter: async (msg) => {
                    await vscode.commands.executeCommand('jj-view.newAfter', ...(msg.payload.changeIds || []));
                },
                resolve: async (msg) => {
                    if (this.jj) {
                        await this.jj.resolve(msg.payload.path);
                        await vscode.commands.executeCommand('jj-view.refresh');
                    }
                },
                moveBookmark: async (msg) => {
                    await this.handleMoveBookmark(msg.payload);
                },
                rebaseCommit: async (msg) => {
                    await this.handleRebaseCommit(msg.payload);
                },
                squashCommit: async (msg) => {
                    await this.handleSquashCommit(msg.payload);
                },
                duplicateCommit: async (msg) => {
                    await this.handleDuplicateCommit(msg.payload);
                },
                mergeCommit: async (msg) => {
                    await this.handleMergeCommit(msg.payload);
                },
                upload: async (msg) => {
                    await vscode.commands.executeCommand('jj-view.upload', msg.payload);
                },
                showComments: async (msg) => {
                    await vscode.commands.executeCommand('jj-view.showComments', msg.payload.changeId);
                },
                selectionChange: async (msg) => {
                    const count = msg.payload.commitIds.length;
                    const hasImmutable = !!msg.payload.hasImmutableSelection;

                    if (count !== 1) {
                        const tabsToClose: vscode.Tab[] = [];
                        for (const tabGroup of vscode.window.tabGroups.all) {
                            for (const tab of tabGroup.tabs) {
                                if (
                                    tab.input instanceof vscode.TabInputCustom &&
                                    tab.input.viewType === JjCommitDetailsEditorProvider.viewType
                                ) {
                                    let isForCurrentRepo = true;
                                    if (this._repo) {
                                        try {
                                            const query = getUriParams(tab.input.uri);
                                            const repoRoot = query.get('repoRoot');
                                            if (repoRoot && repoRoot !== this._repo.rootUri.fsPath) {
                                                isForCurrentRepo = false;
                                            }
                                        } catch {}
                                    }
                                    if (isForCurrentRepo) {
                                        tabsToClose.push(tab);
                                    }
                                }
                            }
                        }
                        if (tabsToClose.length > 0) {
                            await vscode.window.tabGroups.close(tabsToClose);
                        }
                    }

                    const allowAbandon = count > 0 && !hasImmutable;
                    const allowMerge = count > 1;
                    const allowNewBefore = count > 0 && !hasImmutable;

                    let parentMutable = false;
                    if (count === 1) {
                        const selectedCommit = this._cachedCommits.find(
                            (c) => c.change_id === msg.payload.commitIds[0],
                        );
                        if (selectedCommit) {
                            parentMutable = canAbsorbCommit(selectedCommit);
                        }
                    }

                    vscode.commands.executeCommand('setContext', JjContextKey.SelectionAllowAbandon, allowAbandon);
                    vscode.commands.executeCommand('setContext', JjContextKey.SelectionAllowMerge, allowMerge);
                    vscode.commands.executeCommand('setContext', JjContextKey.SelectionAllowNewBefore, allowNewBefore);
                    vscode.commands.executeCommand('setContext', JjContextKey.SelectionParentMutable, parentMutable);

                    if (this._onSelectionChange) {
                        this._onSelectionChange(msg.payload.commitIds);
                    }
                },
            },
            {
                logger: this.outputChannel,
                messenger: webviewView.webview,
            },
        );

        webviewView.webview.onDidReceiveMessage(async (message) => {
            return await dispatcher.dispatch(message);
        });
    }

    public async refresh(reason?: string) {
        if (this._view) {
            const start = performance.now();
            let commits: JjLogEntry[] = [];

            try {
                const reasonStr = reason ? ` (reason: ${reason})` : '';
                this.outputChannel?.info(`[JjLogWebviewProvider] Refreshing${reasonStr}...`);

                if (!this._repo || !(await this._repo.isValid())) {
                    this.outputChannel?.info(
                        `[JjLogWebviewProvider] ${this._repo ? this._repo.rootUri.fsPath : 'No repository'} is not a valid jj repository. Skipping log refresh.`,
                    );
                    this._cachedCommits = [];
                    this._renderCommits([]);
                    return;
                }

                const { jj } = this;
                if (!jj) {
                    return;
                }

                const targetRepoPath = this._repo.rootUri.fsPath;
                // Default jj log (usually local heads/roots)
                const logStart = performance.now();
                commits = await jj.getLog({
                    omitChanges: true,
                    includeNearestVisibleAncestors: true,
                });

                if (this._repo?.rootUri.fsPath !== targetRepoPath) {
                    this.outputChannel?.info(
                        `[JjLogWebviewProvider] Repository changed during log fetch (was ${targetRepoPath}, now ${this._repo?.rootUri.fsPath}). Discarding stale log entries.`,
                    );
                    return;
                }

                const logDuration = performance.now() - logStart;
                this.outputChannel?.info(
                    `[JjLogWebviewProvider] jj log took ${logDuration.toFixed(0)}ms, found ${commits.length} commits`,
                );

                this._cachedCommits = commits;
                this._renderCommits(commits);

                const initialRenderDuration = performance.now() - start;
                this.outputChannel?.info(
                    `[JjLogWebviewProvider] Initial render took ${initialRenderDuration.toFixed(0)}ms`,
                );
            } catch (e) {
                this.outputChannel?.error(`[JjLogWebviewProvider] Failed to fetch log: ${e}`);
                return;
            }

            // Background fetch code forge status for commits
            await this.refreshCodeForge();
        }
    }

    /** Re-fetch code forge data for cached commits and re-render. */
    private async refreshCodeForge() {
        if (!this._view || this._cachedCommits.length === 0) {
            return;
        }
        const cf = this._codeForge;
        if (!cf) {
            return;
        }
        if (!cf.isEnabled) {
            await cf.detectActiveProvider();
            // Since detectActiveProvider() fires onDidUpdate if a provider is detected,
            // that event listener has already triggered a concurrent refreshCodeForge().
            // We return early here to avoid duplicate parallel fetches.
            return;
        }

        try {
            this._codeForge.startPolling();

            const start = performance.now();
            const hasChanges = await this._codeForge.ensureFreshStatuses(
                this._cachedCommits.map((c) => ({
                    commitId: c.commit_id ?? '',
                    changeId: c.change_id,
                    description: c.description,
                    bookmarks: c.bookmarks?.filter((b) => !b.remote).map((b) => b.name),
                })),
            );

            const duration = performance.now() - start;
            this.outputChannel?.info(`[JjLogWebviewProvider] Code forge fetch took ${duration.toFixed(0)}ms`);

            if (hasChanges) {
                this.outputChannel?.info('[JjLogWebviewProvider] Code forge data changed, re-rendering');
                this._renderCommits(this._cachedCommits);
            }
        } catch (e) {
            this.outputChannel?.error(`[JjLogWebviewProvider] Code forge refresh failed: ${e}`);
        }
    }

    private _renderCommits(commits: JjLogEntry[]) {
        const minChangeIdLength = getJjViewConfig<number>('minChangeIdLength', 1) ?? 1;
        const logTheme = getJjViewConfig<string>('logTheme', 'default') ?? 'default';
        const graphLabelAlignment = getJjViewConfig<string>('graphLabelAlignment', 'aligned') ?? 'aligned';

        const cf = this._codeForge;
        if (cf?.isEnabled) {
            cf.populateCodeForgeInfo(commits);
        } else {
            this.outputChannel?.info('[JjLogWebviewProvider] Code forge service is disabled.');
        }

        this._view?.webview.postMessage({
            type: 'update',
            commits,
            minChangeIdLength,
            theme: logTheme,
            graphLabelAlignment,
            hiddenActions: this._getHiddenActions(),
        });
    }

    private _getHiddenActions(): string[] {
        return this._context.globalState.get<string[]>(this._hiddenActionsKey, []);
    }

    public async toggleActionVisibility(actionId: ToggleableCommitAction) {
        const hidden = new Set(this._getHiddenActions());
        if (hidden.has(actionId)) {
            hidden.delete(actionId);
        } else {
            hidden.add(actionId);
        }
        const newHidden = Array.from(hidden);
        await this._context.globalState.update(this._hiddenActionsKey, newHidden);

        this._updateContextKeys();

        this._view?.webview.postMessage({
            type: 'updateHiddenActions',
            payload: { hiddenActions: newHidden },
        });
    }

    private _updateContextKeys() {
        const hiddenActions = this._getHiddenActions();
        const hidden = new Set(hiddenActions);
        for (const actionId of TOGGLEABLE_COMMIT_ACTIONS) {
            const key = `jj.commitActionVisible.${actionId}`;
            const value = !hidden.has(actionId);
            vscode.commands.executeCommand('setContext', key, value);
        }
    }

    public async createCommitDetailsPanel(
        changeId: string,
        changeIdShortest?: string,
        isDivergent?: boolean,
        changeIdOffset?: number,
    ) {
        if (!this._repo) {
            return;
        }
        await openCommitDetails(this._repo.rootUri.fsPath, changeId, changeIdShortest, isDivergent, changeIdOffset);
    }

    private _getHtmlForWebview(webview: vscode.Webview, initialData?: unknown) {
        const scriptUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'dist', 'webview', 'index.js'));
        const styleUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'media', 'main.css'));
        const themesUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'media', 'themes.generated.css'));
        const codiconsUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'media', 'codicons', 'codicon.css'));

        const nonce = getNonce();
        const initialDataScript = initialData ? `window.vscodeInitialData = ${JSON.stringify(initialData)};` : '';

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
                <link href="${styleUri}" rel="stylesheet">
                <link href="${themesUri}" rel="stylesheet">
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

    private async executeJjMutation(
        progressTitle: string,
        failureMessage: string,
        operation: (jj: JjService) => Promise<unknown>,
    ): Promise<void> {
        if (!this.jj) {
            return;
        }
        try {
            await withDelayedProgress(progressTitle, operation(this.jj));
            await vscode.commands.executeCommand('jj-view.refresh');
        } catch (err) {
            await showJjError(err, failureMessage, this.jj, this.outputChannel);
        }
    }

    private async handleMoveBookmark(payload: { bookmark: string; targetChangeId: string }): Promise<void> {
        if (!payload?.bookmark || !payload?.targetChangeId) {
            return;
        }
        return this.executeJjMutation('Moving bookmark...', 'Failed to move bookmark', (jj) =>
            jj.moveBookmark(payload.bookmark, payload.targetChangeId),
        );
    }

    private async handleRebaseCommit(payload: {
        sourceChangeId: string;
        targetChangeId: string;
        mode: 'source' | 'revision';
    }): Promise<void> {
        if (!payload?.sourceChangeId || !payload?.targetChangeId || payload.sourceChangeId === payload.targetChangeId) {
            return;
        }
        return this.executeJjMutation('Rebasing...', 'Failed to rebase', (jj) =>
            jj.rebase(payload.sourceChangeId, payload.targetChangeId, payload.mode),
        );
    }

    private async handleSquashCommit(payload: {
        sourceChangeId: string;
        targetChangeId: string;
        mode: 'into' | 'onto';
    }): Promise<void> {
        if (!payload?.sourceChangeId || !payload?.targetChangeId || payload.sourceChangeId === payload.targetChangeId) {
            return;
        }
        const options =
            payload.mode === 'onto'
                ? { ontoRevision: payload.targetChangeId }
                : { intoRevision: payload.targetChangeId };
        return this.executeJjMutation('Squashing...', 'Failed to squash', (jj) =>
            jj.squashRevision({ revision: payload.sourceChangeId, ...options }),
        );
    }

    private async handleDuplicateCommit(payload: { sourceChangeId: string; targetChangeId?: string }): Promise<void> {
        if (!payload?.sourceChangeId || payload.sourceChangeId === payload.targetChangeId) {
            return;
        }
        return this.executeJjMutation('Duplicating...', 'Failed to duplicate', (jj) =>
            jj.duplicate(payload.sourceChangeId, payload.targetChangeId ? { onto: payload.targetChangeId } : {}),
        );
    }

    private async handleMergeCommit(payload: { sourceChangeId: string; targetChangeId: string }): Promise<void> {
        if (!payload?.sourceChangeId || !payload?.targetChangeId || payload.sourceChangeId === payload.targetChangeId) {
            return;
        }
        return this.executeJjMutation('Creating merge commit...', 'Failed to create merge commit', (jj) =>
            jj.new({ parents: [payload.sourceChangeId, payload.targetChangeId] }),
        );
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
