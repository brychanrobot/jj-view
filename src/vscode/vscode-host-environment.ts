/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Event, EventEmitter } from '../core/host/events';
import type {
    HostAuth,
    HostAuthSession,
    HostCommands,
    HostConfig,
    HostConfigurationChangeEvent,
    HostDiffTab,
    HostDisposable,
    HostDocuments,
    HostEnvironment,
    HostExtensions,
    HostNavigation,
    HostSecrets,
    HostStorage,
    HostUi,
    HostViews,
    HostWorkspace,
    HostWorkspaceFolder,
    HostWorkspaceFoldersChangeEvent,
} from '../core/host/host-environment';
import { createCommitDetailsUri, getFsPathFromUri, getUriParams, toFileUri, Uri } from '../core/uri-utils';
import { formatCommitTitle } from '../utils/jj-utils';
import { getJjViewConfig } from './config-utils';

export class VsCodeHostUi implements HostUi {
    async showInputBox(options?: {
        prompt?: string;
        value?: string;
        placeHolder?: string;
        validateInput?: (value: string) => string | null | undefined | Promise<string | null | undefined>;
    }): Promise<string | undefined> {
        return await vscode.window.showInputBox(options);
    }

    async showQuickPick<T extends { label: string; value?: unknown }>(
        items: T[],
        options?: {
            placeHolder?: string;
            title?: string;
            matchOnDescription?: boolean;
            matchOnDetail?: boolean;
            acceptCustomValue?: boolean;
        },
    ): Promise<T | undefined> {
        const quickPick = vscode.window.createQuickPick<T & vscode.QuickPickItem>();
        quickPick.items = items as (T & vscode.QuickPickItem)[];
        if (options?.placeHolder) {
            quickPick.placeholder = options.placeHolder;
        }
        if (options?.title) {
            quickPick.title = options.title;
        }
        if (options?.matchOnDescription !== undefined) {
            quickPick.matchOnDescription = options.matchOnDescription;
        }
        if (options?.matchOnDetail !== undefined) {
            quickPick.matchOnDetail = options.matchOnDetail;
        }
        quickPick.ignoreFocusOut = true;

        return new Promise<T | undefined>((resolve) => {
            quickPick.onDidAccept(() => {
                const selected = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
                if (selected) {
                    resolve(selected);
                } else if (options?.acceptCustomValue && quickPick.value.trim().length > 0) {
                    const custom = quickPick.value.trim();
                    const customItem = Object.assign({} as T, { label: custom, value: custom, detail: custom });
                    resolve(customItem);
                } else {
                    resolve(undefined);
                }
                quickPick.dispose();
            });
            quickPick.onDidHide(() => {
                resolve(undefined);
                quickPick.dispose();
            });
            quickPick.show();
        });
    }

    async showMultiQuickPick<T extends { label: string; value?: unknown }>(
        items: T[],
        options?: { placeHolder?: string },
    ): Promise<T[] | undefined> {
        return await vscode.window.showQuickPick(items, { ...options, canPickMany: true });
    }

    async showInformation(message: string, ...actions: string[]): Promise<string | undefined> {
        if (actions.length === 0) {
            void vscode.window.showInformationMessage(message);
            return undefined;
        }
        return await vscode.window.showInformationMessage(message, ...actions);
    }

    async showWarning(message: string, ...actions: string[]): Promise<string | undefined> {
        return await vscode.window.showWarningMessage(message, ...actions);
    }

    async showModalWarning(message: string, ...actions: string[]): Promise<string | undefined> {
        return await vscode.window.showWarningMessage(message, { modal: true }, ...actions);
    }

    async showErrorMessage(message: string, ...actions: string[]): Promise<string | undefined> {
        if (actions.length === 0) {
            void vscode.window.showErrorMessage(message);
            return undefined;
        }
        return await vscode.window.showErrorMessage(message, ...actions);
    }

    async withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
        let taskCompleted = false;
        let progressComplete: (() => void) | undefined;

        const timer = setTimeout(() => {
            if (taskCompleted) {
                return;
            }
            void vscode.window
                .withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title,
                        cancellable: false,
                    },
                    () =>
                        new Promise<void>((resolve) => {
                            progressComplete = resolve;
                            if (taskCompleted) {
                                resolve();
                            }
                        }),
                )
                .then(undefined, () => {});
        }, 100);

        try {
            return await task();
        } finally {
            taskCompleted = true;
            clearTimeout(timer);
            if (progressComplete) {
                progressComplete();
            }
        }
    }

    setStatusBarMessage(message: string, timeoutMs?: number): void {
        if (timeoutMs !== undefined) {
            vscode.window.setStatusBarMessage(message, timeoutMs);
        } else {
            vscode.window.setStatusBarMessage(message);
        }
    }

    get isFocused(): boolean {
        return vscode.window.state.focused;
    }

    readonly onDidChangeFocus: Event<boolean> = (listener, thisArgs, disposables) => {
        const disposable = vscode.window.onDidChangeWindowState((state) => {
            listener.call(thisArgs, state.focused);
        });
        if (disposables) {
            disposables.push(disposable);
        }
        return disposable;
    };
}

export class VsCodeHostConfig implements HostConfig {
    readonly onDidChangeConfiguration: Event<HostConfigurationChangeEvent> = (listener, thisArgs, disposables) => {
        const disposable = vscode.workspace.onDidChangeConfiguration((e) => {
            listener.call(thisArgs, {
                affectsConfiguration: (section: string) => e.affectsConfiguration(section),
            });
        });
        if (disposables) {
            disposables.push(disposable);
        }
        return disposable;
    };

    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        const normalizedKey = key.startsWith('jj-view.') ? key.slice('jj-view.'.length) : key;
        return getJjViewConfig<T>(normalizedKey, defaultValue) ?? defaultValue;
    }

    async update<T>(key: string, value: T): Promise<void> {
        const normalizedKey = key.startsWith('jj-view.') ? key.slice('jj-view.'.length) : key;
        await vscode.workspace
            .getConfiguration('jj-view')
            .update(normalizedKey, value, vscode.ConfigurationTarget.Global);
    }
}

export class VsCodeHostNavigation implements HostNavigation {
    async openDiff(leftUri: Uri, rightUri: Uri, title: string): Promise<void> {
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    }

    async openMultiDiff(title: string, resources: { leftUri: Uri; rightUri: Uri; label: string }[]): Promise<void> {
        // vscode.changes expects 3-tuples of [labelUri, leftUri, rightUri] where labelUri is the target resource URI
        const changes = resources.map((r) => [r.rightUri, r.leftUri, r.rightUri]);
        await vscode.commands.executeCommand('vscode.changes', title, changes);
    }

    async openMergeEditor(resourceUri: Uri): Promise<void> {
        const fsPath = getFsPathFromUri(resourceUri);
        const encodedPath = encodeURIComponent(fsPath);
        const relativePath = vscode.workspace.asRelativePath(toFileUri(resourceUri));
        const virtualPath = path.posix.join('/', relativePath);

        const baseUri = resourceUri.with({
            scheme: 'jj-merge-output',
            authority: 'jj-merge',
            path: virtualPath,
            fragment: `path=${encodedPath}&part=base`,
        });
        const leftUri = resourceUri.with({
            scheme: 'jj-merge-output',
            authority: 'jj-merge',
            path: virtualPath,
            fragment: `path=${encodedPath}&part=left`,
        });
        const rightUri = resourceUri.with({
            scheme: 'jj-merge-output',
            authority: 'jj-merge',
            path: virtualPath,
            fragment: `path=${encodedPath}&part=right`,
        });
        const outputUri = toFileUri(resourceUri);
        const args = {
            base: baseUri,
            input1: { uri: leftUri, title: 'Side 1' },
            input2: { uri: rightUri, title: 'Side 2' },
            output: outputUri,
        };
        await vscode.commands.executeCommand('_open.mergeEditor', args);
    }

    async openCommitDetails(
        repoRoot: Uri,
        changeId: string,
        shortestChangeId?: string,
        isDivergent?: boolean,
        changeIdOffset?: number,
    ): Promise<void> {
        const minLength = getJjViewConfig<number>('minChangeIdLength', 1) ?? 1;
        const title = formatCommitTitle(
            {
                change_id: changeId,
                change_id_shortest: shortestChangeId,
                is_divergent: isDivergent,
                change_id_offset: changeIdOffset,
            },
            minLength,
        );

        const uri = createCommitDetailsUri({
            repoRoot: repoRoot.fsPath,
            changeId,
            title,
        });

        await this.closeOtherCommitDetailsTabs(uri, repoRoot.fsPath);

        await vscode.commands.executeCommand('vscode.openWith', uri, 'jj-view.commitDetailsEditor', {
            preview: true,
            viewColumn: vscode.ViewColumn.Active,
        });
    }

    async closeCommitDetailsTabs(
        predicate: (repoRoot?: Uri) => boolean,
        viewType: string = 'jj-view.commitDetailsEditor',
    ): Promise<void> {
        await closeMatchingTabs((tab) => {
            if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.viewType !== viewType) {
                return false;
            }
            try {
                const query = getUriParams(tab.input.uri);
                const repoRootPath = query.get('repoRoot');
                const repoRootUri = repoRootPath ? Uri.file(repoRootPath) : undefined;
                return predicate(repoRootUri);
            } catch {
                return predicate(undefined);
            }
        });
    }

    private async closeOtherCommitDetailsTabs(
        currentUri: Uri,
        workspaceRoot: string | undefined,
        viewType: string = 'jj-view.commitDetailsEditor',
    ): Promise<void> {
        await closeMatchingTabs((tab) => {
            if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.viewType !== viewType) {
                return false;
            }
            if (tab.input.uri.toString() === currentUri.toString()) {
                return false;
            }
            try {
                const query = getUriParams(tab.input.uri);
                const tabRepoRoot = query.get('repoRoot');
                return !tabRepoRoot || tabRepoRoot === workspaceRoot;
            } catch {
                return true;
            }
        });
    }

    async openFile(uri: Uri): Promise<void> {
        await vscode.commands.executeCommand('vscode.open', uri);
    }

    async openFolder(folderUri: Uri, forceNewWindow?: boolean): Promise<void> {
        await vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow });
    }

    async openExternal(target: Uri): Promise<void> {
        await vscode.env.openExternal(vscode.Uri.parse(target.toString()));
    }

    async copyToClipboard(text: string): Promise<void> {
        await vscode.env.clipboard.writeText(text);
    }

    async openSettings(settingId?: string): Promise<void> {
        await vscode.commands.executeCommand('workbench.action.openSettings', settingId);
    }

    async focusScmInput(): Promise<void> {
        await vscode.commands.executeCommand('workbench.view.scm');
        await vscode.commands.executeCommand('list.focusFirst');
        await vscode.commands.executeCommand('list.select');
    }

    async closeTab(uri: Uri): Promise<void> {
        await closeTabsForUri(uri);
    }
}

export async function closeMatchingTabs(predicate: (tab: vscode.Tab) => boolean): Promise<void> {
    const tabsToClose: vscode.Tab[] = [];
    for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
            if (predicate(tab)) {
                tabsToClose.push(tab);
            }
        }
    }
    if (tabsToClose.length > 0) {
        await vscode.window.tabGroups.close(tabsToClose);
    }
}

export async function closeTabsForUri(uri: Uri): Promise<void> {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const targetFsPath = uri.fsPath.toLowerCase();
    const matchingTabs = tabs.filter(
        (t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath.toLowerCase() === targetFsPath,
    );
    for (const tab of matchingTabs) {
        await vscode.window.tabGroups.close(tab);
    }
}

export class VsCodeHostDocuments implements HostDocuments, HostDisposable {
    private readonly _onDidChangeActiveDocumentEmitter = new EventEmitter<Uri | undefined>();
    readonly onDidChangeActiveDocument: Event<Uri | undefined> = this._onDidChangeActiveDocumentEmitter.event;
    private readonly _disposables: vscode.Disposable[] = [];

    readonly onDidSaveDocument: Event<Uri> = (listener, thisArgs, disposables) => {
        const disposable = vscode.workspace.onDidSaveTextDocument((doc) => {
            listener.call(thisArgs, doc.uri);
        });
        if (disposables) {
            disposables.push(disposable);
        }
        return disposable;
    };

    constructor() {
        const notify = () => {
            this._onDidChangeActiveDocumentEmitter.fire(this.getActiveDocumentUri());
        };
        const d1 = vscode.window.tabGroups?.onDidChangeTabs?.(notify);
        if (d1) {
            this._disposables.push(d1);
        }
        const d2 = vscode.window.tabGroups?.onDidChangeTabGroups?.(notify);
        if (d2) {
            this._disposables.push(d2);
        }
        const d3 = vscode.window.onDidChangeActiveTextEditor?.(notify);
        if (d3) {
            this._disposables.push(d3);
        }
    }

    dispose(): void {
        this._onDidChangeActiveDocumentEmitter.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
    }

    async readLineRangeText(uri: Uri, startLine1Based: number, endLine1Based: number): Promise<string> {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (endLine1Based < startLine1Based) {
            return '';
        }
        const range = this.getSafeRange(doc, startLine1Based, endLine1Based);
        return doc.getText(range);
    }

    async replaceLineRangeAndSave(
        uri: Uri,
        lineRange: { startLine1Based: number; endLine1Based: number },
        replacementText: string,
    ): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(uri);
        let modifiedRange: vscode.Range;
        if (lineRange.endLine1Based >= lineRange.startLine1Based) {
            modifiedRange = this.getSafeRange(doc, lineRange.startLine1Based, lineRange.endLine1Based);
        } else {
            const insertLine = Math.max(0, Math.min(lineRange.startLine1Based, doc.lineCount));
            modifiedRange = new vscode.Range(insertLine, 0, insertLine, 0);
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.replace(uri, modifiedRange, replacementText);
        await vscode.workspace.applyEdit(workspaceEdit);
        await doc.save();
    }

    async saveIfDirty(uri: Uri): Promise<void> {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
        if (doc?.isDirty) {
            await doc.save();
        }
    }

    getOpenDocumentText(uri: Uri): string | undefined {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
        return doc?.getText();
    }

    getActiveDocumentUri(): Uri | undefined {
        const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
        if (activeTab) {
            const tabUri = this.getUriFromTab(activeTab);
            if (tabUri) {
                return tabUri;
            }
        }
        return vscode.window.activeTextEditor?.document.uri;
    }

    getActiveDocumentSelections(): { startLine: number; endLine: number }[] | undefined {
        return vscode.window.activeTextEditor?.selections.map((s) => ({
            startLine: s.start.line,
            endLine: s.end.line,
        }));
    }

    getOpenDocumentUris(): Uri[] {
        const tabGroups = vscode.window.tabGroups?.all;
        if (!tabGroups) {
            return [];
        }
        return tabGroups
            .flatMap((group) => group.tabs)
            .map((tab) => this.getUriFromTab(tab))
            .filter((uri): uri is Uri => uri !== undefined);
    }

    getOpenDiffTabs(): HostDiffTab[] {
        const tabGroups = vscode.window.tabGroups?.all;
        if (!tabGroups) {
            return [];
        }
        return tabGroups
            .flatMap((group) => group.tabs)
            .filter(
                (tab): tab is vscode.Tab & { input: vscode.TabInputTextDiff } =>
                    tab.input instanceof vscode.TabInputTextDiff,
            )
            .map((tab) => ({
                originalUri: tab.input.original,
                modifiedUri: tab.input.modified,
                close: async () => {
                    await vscode.window.tabGroups?.close(tab);
                },
            }));
    }

    private getUriFromTab(tab: vscode.Tab): Uri | undefined {
        const { input } = tab;
        if (input instanceof vscode.TabInputText) {
            return input.uri;
        }
        if (input instanceof vscode.TabInputCustom) {
            return input.uri;
        }
        if (input instanceof vscode.TabInputNotebook) {
            return input.uri;
        }
        if (input instanceof vscode.TabInputTextDiff) {
            return input.modified;
        }
        if (input instanceof vscode.TabInputNotebookDiff) {
            return input.modified;
        }
        return undefined;
    }

    private getSafeRange(doc: vscode.TextDocument, startLine1Based: number, endLine1Based: number): vscode.Range {
        const { lineCount } = doc;
        if (lineCount === 0) {
            return new vscode.Range(0, 0, 0, 0);
        }
        const startLine = Math.max(0, Math.min(startLine1Based - 1, lineCount - 1));
        const endLine = Math.max(0, Math.min(endLine1Based - 1, lineCount - 1));
        const startPos = new vscode.Position(startLine, 0);
        const endPos = doc.lineAt(endLine).rangeIncludingLineBreak.end;
        return new vscode.Range(startPos, endPos);
    }
}

export class VsCodeHostWorkspace implements HostWorkspace {
    get workspaceFolders(): readonly HostWorkspaceFolder[] | undefined {
        return vscode.workspace.workspaceFolders?.map((f) => ({
            uri: f.uri,
            name: f.name,
        }));
    }

    readonly onDidChangeWorkspaceFolders: Event<HostWorkspaceFoldersChangeEvent> = (
        listener,
        thisArgs,
        disposables,
    ) => {
        return vscode.workspace.onDidChangeWorkspaceFolders(
            (e) => {
                listener.call(thisArgs, {
                    added: e.added.map((f) => ({ uri: f.uri, name: f.name })),
                    removed: e.removed.map((f) => ({ uri: f.uri, name: f.name })),
                });
            },
            undefined,
            disposables,
        );
    };

    async findFiles(pattern: string, baseFolderUri?: Uri, maxResults?: number): Promise<Uri[]> {
        if (baseFolderUri) {
            const folder = vscode.workspace.getWorkspaceFolder(baseFolderUri) ?? baseFolderUri;
            const patternObj = new vscode.RelativePattern(folder, pattern);
            return (await vscode.workspace.findFiles(patternObj, null, maxResults)) as Uri[];
        }
        return (await vscode.workspace.findFiles(pattern, null, maxResults)) as Uri[];
    }
}

export class VsCodeHostStorage implements HostStorage {
    constructor(private readonly workspaceState?: vscode.Memento) {}

    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.workspaceState?.get<T>(key, defaultValue as T) ?? defaultValue;
    }

    async update(key: string, value: unknown): Promise<void> {
        await this.workspaceState?.update(key, value);
    }
}

export class VsCodeHostSecrets implements HostSecrets {
    constructor(private readonly secrets?: vscode.SecretStorage) {}

    async get(key: string): Promise<string | undefined> {
        return await this.secrets?.get(key);
    }

    async store(key: string, value: string): Promise<void> {
        await this.secrets?.store(key, value);
    }

    async delete(key: string): Promise<void> {
        await this.secrets?.delete(key);
    }
}

export class VsCodeHostAuth implements HostAuth {
    async getSession(
        providerId: string,
        scopes: string[],
        options?: { silent?: boolean; createIfNone?: boolean; forceNewSession?: boolean },
    ): Promise<HostAuthSession | undefined> {
        return await vscode.authentication.getSession(providerId, scopes, options);
    }
}

export class VsCodeHostExtensions implements HostExtensions {
    hasExtension(extensionId: string): boolean {
        return !!vscode.extensions.getExtension(extensionId);
    }

    async openExtensionSearch(extensionId: string): Promise<void> {
        await vscode.commands.executeCommand('workbench.extensions.search', extensionId);
    }
}

export class VsCodeHostCommands implements HostCommands {
    registerCommand<T extends (...args: never[]) => unknown>(commandId: string, callback: T): HostDisposable {
        return vscode.commands.registerCommand(commandId, callback);
    }

    async executeCommand<R = unknown>(commandId: string, ...args: unknown[]): Promise<R> {
        return (await vscode.commands.executeCommand(commandId, ...args)) as R;
    }

    async setContextKey(key: string, value: unknown): Promise<void> {
        await vscode.commands.executeCommand('setContext', key, value);
    }
}

export class VsCodeHostViews implements HostViews {
    registerWebviewViewProvider(viewId: string, provider: vscode.WebviewViewProvider): HostDisposable {
        return vscode.window.registerWebviewViewProvider(viewId, provider);
    }

    registerCustomEditorProvider(
        viewType: string,
        provider: vscode.CustomTextEditorProvider,
        options?: { webviewOptions?: vscode.WebviewPanelOptions; supportsMultipleEditorsPerDocument?: boolean },
    ): HostDisposable {
        return vscode.window.registerCustomEditorProvider(viewType, provider, options);
    }

    registerFileSystemProvider(
        scheme: string,
        provider: vscode.FileSystemProvider,
        options?: { isReadonly?: boolean },
    ): HostDisposable {
        return vscode.workspace.registerFileSystemProvider(scheme, provider, options);
    }

    registerFileDecorationProvider(provider: vscode.FileDecorationProvider): HostDisposable {
        return vscode.window.registerFileDecorationProvider(provider);
    }
}

export class VsCodeHostEnvironment implements HostEnvironment, HostDisposable {
    readonly ui: HostUi;
    readonly nav: HostNavigation;
    readonly config: HostConfig;
    readonly documents: HostDocuments;
    readonly storage: HostStorage;
    readonly secrets: HostSecrets;
    readonly auth: HostAuth;
    readonly commands: HostCommands;
    readonly views: HostViews;
    readonly workspace: HostWorkspace;
    readonly extensions: HostExtensions;

    constructor(options: {
        context: vscode.ExtensionContext;
    }) {
        this.ui = new VsCodeHostUi();
        this.nav = new VsCodeHostNavigation();
        this.config = new VsCodeHostConfig();
        this.documents = new VsCodeHostDocuments();
        this.storage = new VsCodeHostStorage(options.context.workspaceState);
        this.secrets = new VsCodeHostSecrets(options.context.secrets);
        this.auth = new VsCodeHostAuth();
        this.commands = new VsCodeHostCommands();
        this.views = new VsCodeHostViews();
        this.workspace = new VsCodeHostWorkspace();
        this.extensions = new VsCodeHostExtensions();
    }

    dispose(): void {
        if ('dispose' in this.documents && typeof this.documents.dispose === 'function') {
            this.documents.dispose();
        }
    }
}
