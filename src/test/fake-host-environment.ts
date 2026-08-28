/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommentsManager } from '../comments-manager';
import type { CommandContext, CommandServices } from '../common/command-context';
import { type Event, EventEmitter } from '../common/events';
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
} from '../common/host-environment';
import type { JjRepository } from '../jj-repository';
import type { Uri } from '../uri-utils';
import type { LoggerChannel } from '../utils/output-channel';

export class FakeHostUi implements HostUi {
    public inputBoxResponses: (string | undefined)[] = [];
    public quickPickResponses: unknown[] = [];
    public infoResponses: (string | undefined)[] = [];
    public warningResponses: (string | undefined)[] = [];
    public errorResponses: (string | undefined)[] = [];

    public infoMessages: string[] = [];
    public warningMessages: string[] = [];
    public errorMessages: string[] = [];
    public progressTitles: string[] = [];
    public statusBarMessages: { message: string; timeoutMs?: number }[] = [];
    public quickPickCalls: {
        items: { label: string; detail?: string; description?: string; value?: unknown }[];
        options?: {
            placeHolder?: string;
            title?: string;
            matchOnDescription?: boolean;
            matchOnDetail?: boolean;
            acceptCustomValue?: boolean;
        };
    }[] = [];

    get warningResponse(): string | undefined {
        return this.warningResponses[0];
    }

    set warningResponse(val: string | undefined) {
        this.warningResponses = val !== undefined ? [val] : [];
    }

    setNextInfoResponse(response: string | undefined): void {
        this.infoResponses.push(response);
    }

    setNextWarningResponse(response: string | undefined): void {
        this.warningResponses.push(response);
    }

    setNextErrorResponse(response: string | undefined): void {
        this.errorResponses.push(response);
    }

    setNextInputBoxResponse(response: string | undefined): void {
        this.inputBoxResponses.push(response);
    }

    setNextQuickPickResponse<T>(response: T | undefined): void {
        this.quickPickResponses.push(response);
    }

    setNextRevisionPromptResponse(revision: string | undefined): void {
        this.quickPickResponses.push(
            revision !== undefined ? { detail: revision, value: revision, label: revision } : undefined,
        );
    }

    setNextSelectOrCreateResponse(choice: string | undefined): void {
        this.quickPickResponses.push(choice !== undefined ? { label: choice, customValue: choice } : undefined);
    }

    async showInputBox(_options?: {
        prompt?: string;
        value?: string;
        placeHolder?: string;
        password?: boolean;
        ignoreFocusOut?: boolean;
        validateInput?: (value: string) => string | null | undefined | Promise<string | null | undefined>;
    }): Promise<string | undefined> {
        return this.inputBoxResponses.shift();
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
        this.quickPickCalls.push({ items, options });
        return this.quickPickResponses.shift() as T | undefined;
    }

    async showMultiQuickPick<T extends { label: string; value?: unknown }>(
        _items: T[],
        _options?: { placeHolder?: string },
    ): Promise<T[] | undefined> {
        return this.quickPickResponses.shift() as T[] | undefined;
    }

    async showInformation(message: string, ..._actions: string[]): Promise<string | undefined> {
        this.infoMessages.push(message);
        return this.infoResponses.shift();
    }

    async showWarning(message: string, ..._actions: string[]): Promise<string | undefined> {
        this.warningMessages.push(message);
        return this.warningResponses.shift();
    }

    async showModalWarning(message: string, ..._actions: string[]): Promise<string | undefined> {
        this.warningMessages.push(message);
        return this.warningResponses.shift();
    }

    async showErrorMessage(message: string, ..._actions: string[]): Promise<string | undefined> {
        this.errorMessages.push(message);
        return this.errorResponses.shift();
    }

    async withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
        this.progressTitles.push(title);
        return await task();
    }

    setStatusBarMessage(message: string, timeoutMs?: number): void {
        this.statusBarMessages.push({ message, timeoutMs });
    }

    public isFocused = true;
    private readonly _onDidChangeFocusEmitter = new EventEmitter<boolean>();
    readonly onDidChangeFocus: Event<boolean> = this._onDidChangeFocusEmitter.event;

    setFocused(focused: boolean): void {
        this.isFocused = focused;
        this._onDidChangeFocusEmitter.fire(focused);
    }
}

export class FakeHostNavigation implements HostNavigation {
    public diffsOpened: { leftUri: Uri; rightUri: Uri; title: string }[] = [];
    public multiDiffsOpened: { title: string; resources: { leftUri: Uri; rightUri: Uri; label: string }[] }[] = [];
    public mergeEditorsOpened: Uri[] = [];
    public commitDetailsOpened: {
        repoRoot: Uri;
        changeId: string;
        shortestChangeId?: string;
        isDivergent?: boolean;
        changeIdOffset?: number;
    }[] = [];
    public closedCommitDetailsPredicates: ((repoRoot?: Uri) => boolean)[] = [];
    public filesOpened: Uri[] = [];
    public foldersOpened: { folderUri: Uri; forceNewWindow?: boolean }[] = [];
    public externalUrisOpened: Uri[] = [];
    public clipboardText = '';
    public settingsOpened: (string | undefined)[] = [];
    public closedTabs: Uri[] = [];
    public focusScmInputCallCount = 0;

    async openDiff(leftUri: Uri, rightUri: Uri, title: string): Promise<void> {
        this.diffsOpened.push({ leftUri, rightUri, title });
    }

    async openMultiDiff(title: string, resources: { leftUri: Uri; rightUri: Uri; label: string }[]): Promise<void> {
        this.multiDiffsOpened.push({ title, resources });
    }

    async openMergeEditor(resourceUri: Uri): Promise<void> {
        this.mergeEditorsOpened.push(resourceUri);
    }

    async openCommitDetails(
        repoRoot: Uri,
        changeId: string,
        shortestChangeId?: string,
        isDivergent?: boolean,
        changeIdOffset?: number,
    ): Promise<void> {
        this.commitDetailsOpened.push({ repoRoot, changeId, shortestChangeId, isDivergent, changeIdOffset });
    }

    async closeCommitDetailsTabs(predicate: (repoRoot?: Uri) => boolean): Promise<void> {
        this.closedCommitDetailsPredicates.push(predicate);
    }

    async openFile(uri: Uri): Promise<void> {
        this.filesOpened.push(uri);
    }

    async openFolder(folderUri: Uri, forceNewWindow?: boolean): Promise<void> {
        this.foldersOpened.push({ folderUri, forceNewWindow });
    }

    async openExternal(target: Uri): Promise<void> {
        this.externalUrisOpened.push(target);
    }

    async copyToClipboard(text: string): Promise<void> {
        this.clipboardText = text;
    }

    async openSettings(settingId?: string): Promise<void> {
        this.settingsOpened.push(settingId);
    }

    async focusScmInput(): Promise<void> {
        this.focusScmInputCallCount++;
    }

    async closeTab(uri: Uri): Promise<void> {
        this.closedTabs.push(uri);
    }
}

export class FakeHostConfig implements HostConfig {
    private readonly values = new Map<string, unknown>();
    private readonly _onDidChangeConfiguration = new EventEmitter<HostConfigurationChangeEvent>();
    public readonly onDidChangeConfiguration: Event<HostConfigurationChangeEvent> =
        this._onDidChangeConfiguration.event;

    private normalizeKey(key: string): string {
        return key.startsWith('jj-view.') ? key.slice('jj-view.'.length) : key;
    }

    set<T>(key: string, value: T): void {
        const normalized = this.normalizeKey(key);
        this.values.set(normalized, value);
        this._onDidChangeConfiguration.fire({
            affectsConfiguration: (section: string) => {
                const normSection = this.normalizeKey(section);
                return (
                    normalized === normSection ||
                    normalized.startsWith(`${normSection}.`) ||
                    normSection.startsWith(`${normalized}.`)
                );
            },
        });
    }

    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        const normalized = this.normalizeKey(key);
        if (this.values.has(normalized)) {
            return this.values.get(normalized) as T;
        }
        return defaultValue;
    }

    async update<T>(key: string, value: T): Promise<void> {
        this.set(key, value);
    }

    clear(): void {
        this.values.clear();
    }
}

export class FakeHostDocuments implements HostDocuments {
    private readonly virtualDocs = new Map<string, string>();
    public savedUris: Uri[] = [];

    setDocumentText(uri: Uri, text: string): void {
        this.virtualDocs.set(uri.fsPath, text);
    }

    async readLineRangeText(uri: Uri, startLine1Based: number, endLine1Based: number): Promise<string> {
        let text = this.virtualDocs.get(uri.fsPath);
        if (text === undefined) {
            if (fs.existsSync(uri.fsPath)) {
                text = fs.readFileSync(uri.fsPath, 'utf8');
            } else {
                text = '';
            }
        }
        if (endLine1Based < startLine1Based) {
            return '';
        }
        const lines = text.split(/\r?\n/);
        const start = Math.max(0, startLine1Based - 1);
        const end = Math.min(lines.length, endLine1Based);
        return lines.slice(start, end).join('\n');
    }

    async replaceLineRangeAndSave(
        uri: Uri,
        lineRange: { startLine1Based: number; endLine1Based: number },
        replacementText: string,
    ): Promise<void> {
        let text = this.virtualDocs.get(uri.fsPath);
        if (text === undefined) {
            if (fs.existsSync(uri.fsPath)) {
                text = fs.readFileSync(uri.fsPath, 'utf8');
            } else {
                text = '';
            }
        }
        const lines = text.split(/\r?\n/);
        const start = Math.max(0, lineRange.startLine1Based - 1);
        const end = Math.max(start, lineRange.endLine1Based);
        const replacementLines = replacementText.length > 0 ? replacementText.split(/\r?\n/) : [];
        lines.splice(start, end - start, ...replacementLines);
        const updated = lines.join('\n');
        this.virtualDocs.set(uri.fsPath, updated);
        this.savedUris.push(uri);
        if (fs.existsSync(uri.fsPath)) {
            fs.writeFileSync(uri.fsPath, updated, 'utf8');
        }
    }

    async saveIfDirty(uri: Uri): Promise<void> {
        this.savedUris.push(uri);
        const text = this.virtualDocs.get(uri.fsPath);
        if (text !== undefined && fs.existsSync(uri.fsPath)) {
            fs.writeFileSync(uri.fsPath, text, 'utf8');
        }
    }

    private activeDocumentUri: Uri | undefined = undefined;
    private activeDocumentSelections: { startLine: number; endLine: number }[] | undefined = undefined;
    public openDocumentUris: Uri[] = [];
    public openDiffTabs: HostDiffTab[] = [];
    private readonly _onDidChangeActiveDocumentEmitter = new EventEmitter<Uri | undefined>();
    readonly onDidChangeActiveDocument: Event<Uri | undefined> = this._onDidChangeActiveDocumentEmitter.event;
    private readonly _onDidSaveDocumentEmitter = new EventEmitter<Uri>();
    readonly onDidSaveDocument: Event<Uri> = this._onDidSaveDocumentEmitter.event;

    fireDidSaveDocument(uri: Uri): void {
        this._onDidSaveDocumentEmitter.fire(uri);
    }

    setActiveDocument(uri: Uri | undefined, selections?: { startLine: number; endLine: number }[]): void {
        this.activeDocumentUri = uri;
        this.activeDocumentSelections = selections;
        this._onDidChangeActiveDocumentEmitter.fire(uri);
    }

    getActiveDocumentUri(): Uri | undefined {
        return this.activeDocumentUri;
    }

    getActiveDocumentSelections(): { startLine: number; endLine: number }[] | undefined {
        return this.activeDocumentSelections;
    }

    getOpenDocumentUris(): Uri[] {
        return this.openDocumentUris;
    }

    getOpenDiffTabs(): readonly HostDiffTab[] {
        return this.openDiffTabs;
    }

    getOpenDocumentText(uri: Uri): string | undefined {
        return this.virtualDocs.get(uri.fsPath);
    }
}

export class FakeHostWorkspace implements HostWorkspace {
    public readonly folders = new Map<string, HostWorkspaceFolder>();
    private readonly _onDidChangeWorkspaceFoldersEmitter = new EventEmitter<HostWorkspaceFoldersChangeEvent>();
    readonly onDidChangeWorkspaceFolders: Event<HostWorkspaceFoldersChangeEvent> =
        this._onDidChangeWorkspaceFoldersEmitter.event;

    get workspaceFolders(): readonly HostWorkspaceFolder[] {
        return Array.from(this.folders.values());
    }

    addFolder(uri: Uri, name?: string): void {
        const folder: HostWorkspaceFolder = {
            uri,
            name: name ?? path.basename(uri.fsPath),
        };
        this.folders.set(uri.fsPath, folder);
        this._onDidChangeWorkspaceFoldersEmitter.fire({ added: [folder], removed: [] });
    }

    removeFolder(uri: Uri): void {
        const removed = this.folders.get(uri.fsPath);
        if (removed) {
            this.folders.delete(uri.fsPath);
            this._onDidChangeWorkspaceFoldersEmitter.fire({ added: [], removed: [removed] });
        }
    }

    async findFiles(_pattern: string, _baseFolderUri?: Uri, _maxResults?: number): Promise<Uri[]> {
        return [];
    }
}

export class FakeHostStorage implements HostStorage {
    private readonly storage = new Map<string, unknown>();

    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        if (this.storage.has(key)) {
            return this.storage.get(key) as T;
        }
        return defaultValue;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.storage.delete(key);
        } else {
            this.storage.set(key, value);
        }
    }
}

export class FakeHostSecrets implements HostSecrets {
    private readonly secrets = new Map<string, string>();

    async get(key: string): Promise<string | undefined> {
        return this.secrets.get(key);
    }

    async store(key: string, value: string): Promise<void> {
        this.secrets.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.secrets.delete(key);
    }
}

export class FakeHostAuth implements HostAuth {
    private readonly sessions = new Map<string, HostAuthSession>();

    setSession(providerId: string, session: HostAuthSession): void {
        this.sessions.set(providerId, session);
    }

    async getSession(
        providerId: string,
        _scopes: string[],
        _options?: { silent?: boolean; createIfNone?: boolean; forceNewSession?: boolean },
    ): Promise<HostAuthSession | undefined> {
        return this.sessions.get(providerId);
    }
}

export class FakeHostExtensions implements HostExtensions {
    public installedExtensions = new Set<string>();
    public searchedExtensions: string[] = [];

    hasExtension(extensionId: string): boolean {
        return this.installedExtensions.has(extensionId);
    }

    async openExtensionSearch(extensionId: string): Promise<void> {
        this.searchedExtensions.push(extensionId);
    }
}

export class FakeHostCommands implements HostCommands {
    public executedCommands: { commandId: string; args: unknown[] }[] = [];
    public contextKeys = new Map<string, unknown>();
    private readonly handlers = new Map<string, (...args: never[]) => unknown>();

    registerCommand<T extends (...args: never[]) => unknown>(commandId: string, callback: T): HostDisposable {
        this.handlers.set(commandId, callback);
        return {
            dispose: () => {
                this.handlers.delete(commandId);
            },
        };
    }

    async executeCommand<R = unknown>(commandId: string, ...args: unknown[]): Promise<R> {
        this.executedCommands.push({ commandId, args });
        const handler = this.handlers.get(commandId);
        if (handler) {
            return (await handler(...(args as never[]))) as R;
        }
        return undefined as R;
    }

    async setContextKey(key: string, value: unknown): Promise<void> {
        this.contextKeys.set(key, value);
    }
}

export class FakeHostViews implements HostViews {
    public registeredViews = new Map<string, unknown>();

    registerWebviewViewProvider(viewId: string, provider: unknown): HostDisposable {
        this.registeredViews.set(`webview:${viewId}`, provider);
        return { dispose: () => this.registeredViews.delete(`webview:${viewId}`) };
    }

    registerCustomEditorProvider(viewType: string, provider: unknown): HostDisposable {
        this.registeredViews.set(`editor:${viewType}`, provider);
        return { dispose: () => this.registeredViews.delete(`editor:${viewType}`) };
    }

    registerFileSystemProvider(scheme: string, provider: unknown): HostDisposable {
        this.registeredViews.set(`fs:${scheme}`, provider);
        return { dispose: () => this.registeredViews.delete(`fs:${scheme}`) };
    }

    registerFileDecorationProvider(provider: unknown): HostDisposable {
        this.registeredViews.set('decoration', provider);
        return { dispose: () => this.registeredViews.delete('decoration') };
    }
}

export class FakeHostEnvironment implements HostEnvironment {
    readonly ui: FakeHostUi;
    readonly nav: FakeHostNavigation;
    readonly config: FakeHostConfig;
    readonly documents: FakeHostDocuments;
    readonly storage: FakeHostStorage;
    readonly secrets: FakeHostSecrets;
    readonly auth: FakeHostAuth;
    readonly commands: FakeHostCommands;
    readonly views: FakeHostViews;
    readonly workspace: FakeHostWorkspace;
    public extensions?: FakeHostExtensions;

    constructor() {
        this.ui = new FakeHostUi();
        this.nav = new FakeHostNavigation();
        this.config = new FakeHostConfig();
        this.documents = new FakeHostDocuments();
        this.storage = new FakeHostStorage();
        this.secrets = new FakeHostSecrets();
        this.auth = new FakeHostAuth();
        this.commands = new FakeHostCommands();
        this.views = new FakeHostViews();
        this.workspace = new FakeHostWorkspace();
        this.extensions = new FakeHostExtensions();
    }
}

export class FakeCommandContext implements CommandContext {
    readonly services?: CommandServices;

    constructor(
        readonly repo: JjRepository,
        readonly host: FakeHostEnvironment = new FakeHostEnvironment(),
        readonly log: LoggerChannel = {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
            trace: () => {},
            replace: () => {},
            show: () => {},
            hide: () => {},
            clear: () => {},
            dispose: () => {},
            name: 'test',
        },
        readonly comments?: CommentsManager,
    ) {
        this.services = { commentsManager: comments };
    }
}
