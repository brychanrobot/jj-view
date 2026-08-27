/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Event } from '../common/events';
import type {
    HostAuth,
    HostAuthSession,
    HostCommands,
    HostConfig,
    HostConfigurationChangeEvent,
    HostDisposable,
    HostDocuments,
    HostEnvironment,
    HostNavigation,
    HostSecrets,
    HostStorage,
    HostUi,
    HostViews,
} from '../common/host-environment';
import type { JjRepository } from '../jj-repository';
import { getFsPathFromUri, toFileUri, type Uri } from '../uri-utils';
import { getJjViewConfig } from '../utils/config-utils';
import { getErrorMessage } from '../utils/error-utils';
import type { LoggerChannel } from '../utils/output-channel';
import { openCommitDetails, promptForRevision, showJjError, withDelayedProgress } from './vscode-ui-helpers';

export class VsCodeHostUi implements HostUi {
    constructor(
        private readonly repo?: JjRepository,
        private readonly log?: LoggerChannel,
        private readonly sourceControl?: { inputBox: { value: string } },
    ) {}

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
        options?: { placeHolder?: string; title?: string },
    ): Promise<T | undefined> {
        return await vscode.window.showQuickPick(items, options);
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

    async showWarning(
        message: string,
        optionsOrAction?: { modal?: boolean } | string,
        ...actions: string[]
    ): Promise<string | undefined> {
        if (typeof optionsOrAction === 'object' && optionsOrAction !== null) {
            return await vscode.window.showWarningMessage(message, optionsOrAction, ...actions);
        }
        const allActions = typeof optionsOrAction === 'string' ? [optionsOrAction, ...actions] : actions;
        return await vscode.window.showWarningMessage(message, ...allActions);
    }

    async showError(error: unknown, prefix: string, extraActions?: string[]): Promise<string | undefined> {
        if (!this.repo || !this.log) {
            const message = `${prefix}: ${getErrorMessage(error)}`;
            return await vscode.window.showErrorMessage(message, ...(extraActions ?? []));
        }
        return await showJjError(error, prefix, this.repo.jj, this.log, extraActions);
    }

    async promptForRevision(options?: {
        placeHolder?: string;
        revisionQuery?: string;
        emptyPrompt?: string;
    }): Promise<string | undefined> {
        if (!this.repo) {
            return undefined;
        }
        return await promptForRevision(this.repo.jj, options);
    }

    async promptSelectOrCreate(options: {
        placeHolder?: string;
        items: { label: string; description?: string }[];
    }): Promise<string | undefined> {
        return await new Promise<string | undefined>((resolve) => {
            const quickPick = vscode.window.createQuickPick();
            quickPick.placeholder = options.placeHolder;
            quickPick.items = options.items;
            quickPick.matchOnDescription = true;

            quickPick.onDidAccept(() => {
                const selection = quickPick.selectedItems[0];
                const selectedName = selection ? selection.label : quickPick.value.trim();
                resolve(selectedName || undefined);
                quickPick.dispose();
            });

            quickPick.onDidHide(() => {
                resolve(undefined);
                quickPick.dispose();
            });

            quickPick.show();
        });
    }

    async withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
        return await withDelayedProgress(title, task());
    }

    setStatusBarMessage(message: string, timeoutMs?: number): void {
        if (timeoutMs !== undefined) {
            vscode.window.setStatusBarMessage(message, timeoutMs);
        } else {
            vscode.window.setStatusBarMessage(message);
        }
    }

    setScmDescriptionInputValue(value: string): void {
        if (this.sourceControl) {
            this.sourceControl.inputBox.value = value;
        }
    }

    getScmDescriptionInputValue(): string | undefined {
        return this.sourceControl?.inputBox.value;
    }
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
        return getJjViewConfig<T>(key, defaultValue) ?? defaultValue;
    }

    async update<T>(key: string, value: T): Promise<void> {
        await vscode.workspace.getConfiguration('jj-view').update(key, value, vscode.ConfigurationTarget.Global);
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
        repoRoot: string,
        changeId: string,
        shortestChangeId?: string,
        isDivergent?: boolean,
        changeIdOffset?: number,
    ): Promise<void> {
        await openCommitDetails(repoRoot, changeId, shortestChangeId, isDivergent, changeIdOffset);
    }

    async openFile(uri: Uri): Promise<void> {
        await vscode.commands.executeCommand('vscode.open', uri);
    }

    async openFolder(folderUri: Uri, forceNewWindow?: boolean): Promise<void> {
        await vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow });
    }

    async openExternal(url: string): Promise<void> {
        await vscode.env.openExternal(vscode.Uri.parse(url));
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

export class VsCodeHostDocuments implements HostDocuments {
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

export class VsCodeHostStorage implements HostStorage {
    constructor(private readonly workspaceState: vscode.Memento) {}

    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.workspaceState.get<T>(key, defaultValue as T);
    }

    async update(key: string, value: unknown): Promise<void> {
        await this.workspaceState.update(key, value);
    }
}

export class VsCodeHostSecrets implements HostSecrets {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async get(key: string): Promise<string | undefined> {
        return await this.secrets.get(key);
    }

    async store(key: string, value: string): Promise<void> {
        await this.secrets.store(key, value);
    }

    async delete(key: string): Promise<void> {
        await this.secrets.delete(key);
    }
}

export class VsCodeHostAuth implements HostAuth {
    async getSession(
        providerId: string,
        scopes: string[],
        options?: { silent?: boolean; createIfNone?: boolean },
    ): Promise<HostAuthSession | undefined> {
        return await vscode.authentication.getSession(providerId, scopes, options);
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

export class VsCodeHostEnvironment implements HostEnvironment {
    readonly ui: HostUi;
    readonly nav: HostNavigation;
    readonly config: HostConfig;
    readonly documents: HostDocuments;
    readonly storage: HostStorage;
    readonly secrets: HostSecrets;
    readonly auth: HostAuth;
    readonly commands: HostCommands;
    readonly views: HostViews;

    constructor(options: {
        context: vscode.ExtensionContext;
        repo?: JjRepository;
        log?: LoggerChannel;
        sourceControl?: { inputBox: { value: string } };
    }) {
        this.ui = new VsCodeHostUi(options.repo, options.log, options.sourceControl);
        this.nav = new VsCodeHostNavigation();
        this.config = new VsCodeHostConfig();
        this.documents = new VsCodeHostDocuments();
        this.storage = new VsCodeHostStorage(options.context.globalState);
        this.secrets = new VsCodeHostSecrets(options.context.secrets);
        this.auth = new VsCodeHostAuth();
        this.commands = new VsCodeHostCommands();
        this.views = new VsCodeHostViews();
    }
}
