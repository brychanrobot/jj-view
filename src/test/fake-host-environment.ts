/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import type { CommentsManager } from '../comments-manager';
import type { CommandContext, CommandServices } from '../common/command-context';
import type {
    HostAuth,
    HostAuthSession,
    HostCommands,
    HostConfig,
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
import type { Uri } from '../uri-utils';
import type { JjLoggerChannel } from '../utils/output-channel';

export class FakeHostUi implements HostUi {
    public inputBoxResponses: (string | undefined)[] = [];
    public quickPickResponses: unknown[] = [];
    public infoResponses: (string | undefined)[] = [];
    public warningResponses: (string | undefined)[] = [];
    public errorResponses: (string | undefined)[] = [];
    public revisionPromptResponses: (string | undefined)[] = [];
    public selectOrCreateResponses: (string | undefined)[] = [];

    public infoMessages: string[] = [];
    public warningMessages: string[] = [];
    public errorMessages: { error: unknown; prefix: string }[] = [];
    public progressTitles: string[] = [];
    public statusBarMessages: { message: string; timeoutMs?: number }[] = [];
    public scmDescriptionInputValue: string | undefined = undefined;

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

    setNextRevisionPromptResponse(response: string | undefined): void {
        this.revisionPromptResponses.push(response);
    }

    setNextSelectOrCreateResponse(response: string | undefined): void {
        this.selectOrCreateResponses.push(response);
    }

    async showInputBox(_options?: {
        prompt?: string;
        value?: string;
        placeHolder?: string;
        validateInput?: (value: string) => string | null | undefined | Promise<string | null | undefined>;
    }): Promise<string | undefined> {
        return this.inputBoxResponses.shift();
    }

    async showQuickPick<T extends { label: string; value?: unknown }>(
        _items: T[],
        _options?: { placeHolder?: string; title?: string },
    ): Promise<T | undefined> {
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

    async showWarning(
        message: string,
        _optionsOrAction?: { modal?: boolean } | string,
        ..._actions: string[]
    ): Promise<string | undefined> {
        this.warningMessages.push(message);
        return this.warningResponses.shift();
    }

    async showError(error: unknown, prefix: string, _extraActions?: string[]): Promise<string | undefined> {
        this.errorMessages.push({ error, prefix });
        return this.errorResponses.shift();
    }

    async promptForRevision(_options?: {
        placeHolder?: string;
        revisionQuery?: string;
        emptyPrompt?: string;
    }): Promise<string | undefined> {
        return this.revisionPromptResponses.shift();
    }

    async promptSelectOrCreate(_options: {
        placeHolder?: string;
        items: { label: string; description?: string }[];
    }): Promise<string | undefined> {
        return this.selectOrCreateResponses.shift();
    }

    async withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
        this.progressTitles.push(title);
        return await task();
    }

    setStatusBarMessage(message: string, timeoutMs?: number): void {
        this.statusBarMessages.push({ message, timeoutMs });
    }

    setScmDescriptionInputValue(value: string): void {
        this.scmDescriptionInputValue = value;
    }

    getScmDescriptionInputValue(): string | undefined {
        return this.scmDescriptionInputValue;
    }
}

export class FakeHostNavigation implements HostNavigation {
    public diffsOpened: { leftUri: Uri; rightUri: Uri; title: string }[] = [];
    public multiDiffsOpened: { title: string; resources: { leftUri: Uri; rightUri: Uri; label: string }[] }[] = [];
    public mergeEditorsOpened: Uri[] = [];
    public commitDetailsOpened: {
        repoRoot: string;
        changeId: string;
        shortestChangeId?: string;
        isDivergent?: boolean;
        changeIdOffset?: number;
    }[] = [];
    public filesOpened: Uri[] = [];
    public foldersOpened: { folderUri: Uri; forceNewWindow?: boolean }[] = [];
    public externalUrlsOpened: string[] = [];
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
        repoRoot: string,
        changeId: string,
        shortestChangeId?: string,
        isDivergent?: boolean,
        changeIdOffset?: number,
    ): Promise<void> {
        this.commitDetailsOpened.push({ repoRoot, changeId, shortestChangeId, isDivergent, changeIdOffset });
    }

    async openFile(uri: Uri): Promise<void> {
        this.filesOpened.push(uri);
    }

    async openFolder(folderUri: Uri, forceNewWindow?: boolean): Promise<void> {
        this.foldersOpened.push({ folderUri, forceNewWindow });
    }

    async openExternal(url: string): Promise<void> {
        this.externalUrlsOpened.push(url);
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

    set<T>(key: string, value: T): void {
        this.values.set(key, value);
    }

    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        if (this.values.has(key)) {
            return this.values.get(key) as T;
        }
        return defaultValue;
    }

    async update<T>(key: string, value: T): Promise<void> {
        this.values.set(key, value);
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

    getOpenDocumentText(uri: Uri): string | undefined {
        return this.virtualDocs.get(uri.fsPath);
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
        this.storage.set(key, value);
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
        _options?: { silent?: boolean; createIfNone?: boolean },
    ): Promise<HostAuthSession | undefined> {
        return this.sessions.get(providerId);
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
    }
}

export class FakeCommandContext implements CommandContext {
    readonly services?: CommandServices;

    constructor(
        readonly repo: JjRepository,
        readonly host: FakeHostEnvironment = new FakeHostEnvironment(),
        readonly log: JjLoggerChannel = {
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
            logLevel: 3,
            onDidChangeLogLevel: () => ({ dispose: () => {} }),
        },
        readonly comments?: CommentsManager,
    ) {
        this.services = { commentsManager: comments };
    }
}
