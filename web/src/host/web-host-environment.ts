/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Event, EventEmitter } from '../../../src/core/host/events';
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
    HostOpenOptions,
    HostSecrets,
    HostSecretsChangeEvent,
    HostStorage,
    HostStorageChangeEvent,
    HostUi,
    HostViews,
    HostWorkspace,
    HostWorkspaceFolder,
    HostWorkspaceFoldersChangeEvent,
    TextSelectionRange,
} from '../../../src/core/host/host-environment';
import type { RemoteHostSystem } from '../../../src/core/host/remote-host-system';
import type { Uri } from '../../../src/core/uri-utils';
import { Uri as UriImpl } from '../../../src/core/uri-utils';
import { NotificationService } from '../notifications/notification-service';
import type { NotificationPosition } from '../notifications/notification-types';
import { QuickInputService } from '../quick-input/quick-input-service';
import { StatusBarService } from '../status/status-bar-service';

export interface WebHostNavigationCallbacks {
    onOpenDiff?: (leftUri: Uri, rightUri: Uri, title: string, options?: HostOpenOptions) => Promise<void> | void;
    onOpenFile?: (uri: Uri, options?: HostOpenOptions) => Promise<void> | void;
    onOpenMergeEditor?: (resourceUri: Uri) => Promise<void> | void;
    onOpenCommitDetails?: (changeId: string, options?: HostOpenOptions) => Promise<void> | void;
    onFocusScmInput?: () => Promise<void> | void;
    onOpenSettings?: (settingId?: string) => Promise<void> | void;
    onHighlightCommit?: (repoRoot: Uri, changeId: string | undefined) => void;
    onOpenFolder?: (folderUri: Uri, forceNewWindow?: boolean) => Promise<void> | void;
    onOpenMultiDiff?: (
        title: string,
        resources: { leftUri: Uri; rightUri: Uri; label: string }[],
        options?: HostOpenOptions,
    ) => Promise<void> | void;
    onCloseTab?: (uri: Uri) => Promise<void> | void;
}

export interface ContextKeySetter {
    set(key: string, value: unknown): void;
}

export class WebHostUi implements HostUi {
    private quickInputService?: QuickInputService;
    private notificationService?: NotificationService;
    private statusBarService?: StatusBarService;
    private _isActive: boolean;
    private readonly _onDidChangeActive = new EventEmitter<boolean>();
    private _cleanupListeners?: () => void;

    constructor(
        quickInputService?: QuickInputService,
        notificationService?: NotificationService,
        statusBarService?: StatusBarService,
    ) {
        this.quickInputService = quickInputService;
        this.notificationService = notificationService;
        this.statusBarService = statusBarService;
        this._isActive =
            typeof document !== 'undefined'
                ? !document.hidden && (typeof document.hasFocus === 'function' ? document.hasFocus() : true)
                : true;
        this._setupWindowListeners();
    }

    private _setupWindowListeners(): void {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return;
        }

        const handleFocus = () => this.setActiveState(true);
        const handleBlur = () => {
            const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : false;
            const isVisible = !document.hidden;
            this.setActiveState(isVisible && hasFocus);
        };
        const handleVisibilityChange = () => {
            const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : false;
            const isVisible = !document.hidden;
            this.setActiveState(isVisible && hasFocus);
        };

        window.addEventListener('focus', handleFocus);
        window.addEventListener('blur', handleBlur);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        this._cleanupListeners = () => {
            window.removeEventListener('focus', handleFocus);
            window.removeEventListener('blur', handleBlur);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }

    public setActiveState(active: boolean): void {
        if (this._isActive === active) {
            return;
        }
        this._isActive = active;
        this._onDidChangeActive.fire(active);
    }

    public get isActive(): boolean {
        return this._isActive;
    }

    public get isFocused(): boolean {
        return this._isActive;
    }

    public readonly onDidChangeActive: Event<boolean> = this._onDidChangeActive.event;
    public readonly onDidChangeFocus: Event<boolean> = this._onDidChangeActive.event;

    public dispose(): void {
        if (this._cleanupListeners) {
            this._cleanupListeners();
            this._cleanupListeners = undefined;
        }
        this._onDidChangeActive.dispose();
    }

    public setQuickInputService(service: QuickInputService | undefined): void {
        this.quickInputService = service;
    }

    public setNotificationService(service: NotificationService | undefined): void {
        this.notificationService = service;
    }

    public setStatusBarService(service: StatusBarService | undefined): void {
        this.statusBarService = service;
    }

    public async showInputBox(options?: {
        prompt?: string;
        value?: string;
        placeHolder?: string;
        password?: boolean;
        ignoreFocusOut?: boolean;
        validateInput?: (value: string) => string | null | undefined | Promise<string | null | undefined>;
    }): Promise<string | undefined> {
        if (this.quickInputService) {
            return this.quickInputService.showInputBox({
                prompt: options?.prompt,
                value: options?.value,
                placeHolder: options?.placeHolder,
                password: options?.password,
                validateInput: options?.validateInput,
            });
        }
        if (typeof window === 'undefined') {
            return options?.value;
        }
        const response = window.prompt(options?.prompt || options?.placeHolder || '', options?.value || '');
        return response !== null ? response : undefined;
    }

    public async showQuickPick<
        T extends { label: string; value?: unknown; description?: string; detail?: string; iconClass?: string },
    >(
        items: T[],
        options?: {
            placeHolder?: string;
            title?: string;
            matchOnDescription?: boolean;
            matchOnDetail?: boolean;
            acceptCustomValue?: boolean;
            onDidChangeActive?: (items: readonly T[]) => void;
            onDidChangeValue?: (value: string) => void;
        },
    ): Promise<T | undefined> {
        if (this.quickInputService) {
            return this.quickInputService.showQuickPick(items, options);
        }
        if (items.length === 0) {
            return undefined;
        }
        if (typeof window === 'undefined') {
            return items[0];
        }
        const text = items.map((it, idx) => `${idx + 1}. ${it.label}`).join('\n');
        const res = window.prompt(`${options?.title || options?.placeHolder || 'Choose'}:\n${text}`, '1');
        if (!res) {
            return undefined;
        }
        const trimmed = res.trim();
        const parsedIdx = Number.parseInt(trimmed, 10);
        if (!Number.isNaN(parsedIdx) && parsedIdx >= 1 && parsedIdx <= items.length) {
            return items[parsedIdx - 1];
        }
        const lower = trimmed.toLowerCase();
        return items.find((it) => it.label.toLowerCase() === lower);
    }

    public async showMultiQuickPick<
        T extends { label: string; value?: unknown; description?: string; detail?: string; iconClass?: string },
    >(items: T[], options?: { placeHolder?: string; title?: string }): Promise<T[] | undefined> {
        if (this.quickInputService) {
            return this.quickInputService.showMultiQuickPick(items, options);
        }
        return undefined;
    }

    public async showInformation(message: string, ...actions: string[]): Promise<string | undefined> {
        console.info('[UI Info]', message);
        if (this.notificationService) {
            return await this.notificationService.showInformation(message, ...actions);
        }
        return undefined;
    }

    public async showWarning(message: string, ...actions: string[]): Promise<string | undefined> {
        console.warn('[UI Warning]', message);
        if (this.notificationService) {
            return await this.notificationService.showWarning(message, ...actions);
        }
        return undefined;
    }

    public async showModalWarning(message: string, ...actions: string[]): Promise<string | undefined> {
        console.warn('[UI Modal Warning]', message);
        if (this.notificationService) {
            return await this.notificationService.showModalWarning(message, ...actions);
        }
        return undefined;
    }

    public async showErrorMessage(message: string, ...actions: string[]): Promise<string | undefined> {
        console.error('[UI Error]', message);
        if (this.notificationService) {
            return await this.notificationService.showErrorMessage(message, ...actions);
        }
        if (typeof window !== 'undefined') {
            window.alert(`Error: ${message}`);
        }
        return undefined;
    }

    public setStatusBarMessage(message: string, timeoutMs?: number): void {
        if (this.statusBarService) {
            this.statusBarService.setMessage(message, timeoutMs);
        }
    }

    public async withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
        if (this.statusBarService) {
            return await this.statusBarService.withProgress(title, task);
        }
        return await task();
    }
}

export class WebHostConfig implements HostConfig {
    private readonly values = new Map<string, unknown>([['fileWatcherMode', 'watch']]);
    private readonly _onDidChangeConfiguration = new EventEmitter<HostConfigurationChangeEvent>();
    public readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;
    private readonly _hostSystem?: RemoteHostSystem;
    private _initPromise: Promise<void> | null = null;

    constructor(hostSystem?: RemoteHostSystem) {
        this._hostSystem = hostSystem;
        if (hostSystem && typeof hostSystem.onConfigDidChange === 'function') {
            this._initPromise = this._loadInitialConfig();
            hostSystem.onConfigDidChange(async (key, _scope) => {
                await this._reloadConfig();
                this._onDidChangeConfiguration.fire({
                    affectsConfiguration: (section: string) => {
                        if (!key) {
                            return true;
                        }
                        const norm = key.replace(/^jj-view\./, '');
                        const full = `jj-view.${norm}`;
                        return (
                            key === section ||
                            norm === section ||
                            full === section ||
                            key.startsWith(`${section}.`) ||
                            norm.startsWith(`${section}.`) ||
                            full.startsWith(`${section}.`) ||
                            section.startsWith(`${key}.`) ||
                            section.startsWith(`${norm}.`) ||
                            section.startsWith(`${full}.`) ||
                            section === 'jj-view'
                        );
                    },
                });
            });
        }
    }

    private async _loadInitialConfig(): Promise<void> {
        if (!this._hostSystem || typeof this._hostSystem.getAllConfig !== 'function') {
            return;
        }
        try {
            if (this._hostSystem.ready) {
                await this._hostSystem.ready;
            }
            const all = await this._hostSystem.getAllConfig('effective');
            for (const [k, v] of Object.entries(all)) {
                this.values.set(k, v);
                const norm = k.replace(/^jj-view\./, '');
                this.values.set(norm, v);
            }
        } catch (err) {
            console.warn('[WebHostConfig] Failed to load initial config:', err);
        }
    }

    private async _reloadConfig(): Promise<void> {
        if (!this._hostSystem || typeof this._hostSystem.getAllConfig !== 'function') {
            return;
        }
        try {
            const all = await this._hostSystem.getAllConfig('effective');
            for (const [k, v] of Object.entries(all)) {
                this.values.set(k, v);
                const norm = k.replace(/^jj-view\./, '');
                this.values.set(norm, v);
            }
        } catch (err) {
            console.warn('[WebHostConfig] Failed to reload config:', err);
        }
    }

    public async waitForInit(): Promise<void> {
        if (this._initPromise) {
            await this._initPromise;
        }
    }

    public get<T>(key: string): T | undefined;
    public get<T>(key: string, defaultValue: T): T;
    public get<T>(key: string, defaultValue?: T): T | undefined {
        const norm = key.replace(/^jj-view\./, '');
        if (this.values.has(key)) {
            return this.values.get(key) as T;
        }
        if (this.values.has(norm)) {
            return this.values.get(norm) as T;
        }
        if (this.values.has(`jj-view.${norm}`)) {
            return this.values.get(`jj-view.${norm}`) as T;
        }
        return defaultValue;
    }

    public async update<T>(key: string, value: T, scope: 'user' | 'workspace' = 'user'): Promise<void> {
        const norm = key.replace(/^jj-view\./, '');
        if (value === undefined || value === null) {
            this.values.delete(key);
            this.values.delete(norm);
            this.values.delete(`jj-view.${norm}`);
        } else {
            this.values.set(key, value);
            this.values.set(norm, value);
        }

        if (this._hostSystem?.isConnected && typeof this._hostSystem.setConfig === 'function') {
            try {
                await this._hostSystem.setConfig(key, value, scope);
            } catch (err) {
                console.error('[WebHostConfig] Failed to persist config to daemon:', err);
            }
        }

        const full = `jj-view.${norm}`;
        this._onDidChangeConfiguration.fire({
            affectsConfiguration: (section: string) =>
                key === section ||
                norm === section ||
                full === section ||
                key.startsWith(`${section}.`) ||
                norm.startsWith(`${section}.`) ||
                full.startsWith(`${section}.`) ||
                section.startsWith(`${key}.`) ||
                section.startsWith(`${norm}.`) ||
                section.startsWith(`${full}.`) ||
                section === 'jj-view',
        });
    }
}

export class WebHostNavigation implements HostNavigation {
    private callbacks: WebHostNavigationCallbacks;
    private _highlightDelegate?: (repoRoot: Uri, changeId: string | undefined) => void;

    constructor(callbacks: WebHostNavigationCallbacks = {}) {
        this.callbacks = callbacks;
    }

    public setCallbacks(callbacks: WebHostNavigationCallbacks): void {
        this.callbacks = callbacks;
    }

    public setHighlightDelegate(delegate?: (repoRoot: Uri, changeId: string | undefined) => void): void {
        this._highlightDelegate = delegate;
    }

    public async openDiff(leftUri: Uri, rightUri: Uri, title: string, options?: HostOpenOptions): Promise<void> {
        if (this.callbacks.onOpenDiff) {
            if (options !== undefined) {
                await this.callbacks.onOpenDiff(leftUri, rightUri, title, options);
            } else {
                await this.callbacks.onOpenDiff(leftUri, rightUri, title);
            }
        }
    }

    public async openMultiDiff(
        title: string,
        resources: { leftUri: Uri; rightUri: Uri; label: string }[],
        options?: HostOpenOptions,
    ): Promise<void> {
        if (this.callbacks.onOpenMultiDiff) {
            if (options !== undefined) {
                await this.callbacks.onOpenMultiDiff(title, resources, options);
            } else {
                await this.callbacks.onOpenMultiDiff(title, resources);
            }
            return;
        }
        if (resources.length > 0) {
            const first = resources[0];
            await this.openDiff(first.leftUri, first.rightUri, first.label || title, options);
        }
    }

    public async openMergeEditor(resourceUri: Uri): Promise<void> {
        if (this.callbacks.onOpenMergeEditor) {
            await this.callbacks.onOpenMergeEditor(resourceUri);
        } else if (this.callbacks.onOpenFile) {
            await this.callbacks.onOpenFile(resourceUri);
        }
    }

    public async openCommitDetails(
        _repoRoot: Uri,
        changeId: string,
        _shortestChangeId?: string,
        _isDivergent?: boolean,
        _changeIdOffset?: number,
        options?: HostOpenOptions,
    ): Promise<void> {
        if (this.callbacks.onOpenCommitDetails) {
            if (options !== undefined) {
                await this.callbacks.onOpenCommitDetails(changeId, options);
            } else {
                await this.callbacks.onOpenCommitDetails(changeId);
            }
        }
    }

    public async focusScmInput(): Promise<void> {
        if (this.callbacks.onFocusScmInput) {
            await this.callbacks.onFocusScmInput();
        }
    }

    public async openFile(uri: Uri, options?: HostOpenOptions): Promise<void> {
        if (this.callbacks.onOpenFile) {
            if (options !== undefined) {
                await this.callbacks.onOpenFile(uri, options);
            } else {
                await this.callbacks.onOpenFile(uri);
            }
        }
    }

    public async openFolder(folderUri: Uri, forceNewWindow?: boolean): Promise<void> {
        if (this.callbacks.onOpenFolder) {
            await this.callbacks.onOpenFolder(folderUri, forceNewWindow);
            return;
        }
        if (typeof window === 'undefined') {
            return;
        }
        const targetUrl = new URL(window.location.href);
        targetUrl.searchParams.set('repo', folderUri.fsPath);
        if (forceNewWindow) {
            window.open(targetUrl.toString(), '_blank');
            return;
        }
        window.location.assign(targetUrl.toString());
    }

    public async openExternal(target: Uri): Promise<void> {
        if (typeof window !== 'undefined') {
            window.open(target.toString(), '_blank');
        }
    }

    public async copyToClipboard(text: string): Promise<void> {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText(text);
        }
    }

    public async openSettings(settingId?: string): Promise<void> {
        if (this.callbacks.onOpenSettings) {
            await this.callbacks.onOpenSettings(settingId);
        }
    }

    public async closeTab(uri: Uri): Promise<void> {
        if (this.callbacks.onCloseTab) {
            await this.callbacks.onCloseTab(uri);
        }
    }

    public highlightCommit(repoRoot: Uri, changeId: string | undefined): void {
        if (this._highlightDelegate) {
            this._highlightDelegate(repoRoot, changeId);
        } else if (this.callbacks.onHighlightCommit) {
            this.callbacks.onHighlightCommit(repoRoot, changeId);
        }
    }
}

export interface WebHostDocumentsDelegate {
    getActiveDocumentUri?: () => Uri | undefined;
    getActiveDocumentSelections?: () => readonly TextSelectionRange[] | undefined;
    getOpenDocumentUris?: () => Uri[];
    getOpenDiffTabs?: () => readonly HostDiffTab[];
    getOpenDocumentText?: (uri: Uri) => string | undefined;
    saveIfDirty?: (uri: Uri) => Promise<void>;
}

export class WebHostDocuments implements HostDocuments {
    private delegate?: WebHostDocumentsDelegate;
    private readonly _onDidChangeActiveDocument = new EventEmitter<Uri | undefined>();
    private readonly _onDidSaveDocument = new EventEmitter<Uri>();

    public readonly onDidChangeActiveDocument: Event<Uri | undefined> = this._onDidChangeActiveDocument.event;
    public readonly onDidSaveDocument: Event<Uri> = this._onDidSaveDocument.event;

    constructor(private readonly hostSystem: RemoteHostSystem) {}

    public setDelegate(delegate: WebHostDocumentsDelegate | undefined): void {
        this.delegate = delegate;
    }

    public notifyActiveDocumentChanged(uri: Uri | undefined): void {
        this._onDidChangeActiveDocument.fire(uri);
    }

    public notifyDidSaveDocument(uri: Uri): void {
        this._onDidSaveDocument.fire(uri);
    }

    public async readLineRangeText(uri: Uri, startLine1Based: number, endLine1Based: number): Promise<string> {
        const text = await this.hostSystem.fs.readTextFile(uri.fsPath);
        const lines = text.split(/\r?\n/);
        const start = Math.max(0, startLine1Based - 1);
        const end = Math.max(start, endLine1Based);
        return lines.slice(start, end).join('\n');
    }

    public async replaceLineRangeAndSave(
        uri: Uri,
        lineRange: { startLine1Based: number; endLine1Based: number },
        replacementText: string,
    ): Promise<void> {
        const text = await this.hostSystem.fs.readTextFile(uri.fsPath);
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const lines = text.split(/\r?\n/);
        const isPureInsertion = lineRange.endLine1Based === 0 || lineRange.endLine1Based < lineRange.startLine1Based;
        const replacementLines = replacementText.length > 0 ? replacementText.split(/\r?\n/) : [];

        if (isPureInsertion) {
            const insertIndex = lineRange.startLine1Based === 0 ? 0 : Math.min(lineRange.startLine1Based, lines.length);
            lines.splice(insertIndex, 0, ...replacementLines);
        } else {
            const start = Math.max(0, lineRange.startLine1Based - 1);
            const end = Math.max(start, lineRange.endLine1Based);
            lines.splice(start, end - start, ...replacementLines);
        }
        await this.hostSystem.fs.writeTextFile(uri.fsPath, lines.join(eol));
        this._onDidSaveDocument.fire(uri);
    }

    public async saveIfDirty(uri: Uri): Promise<void> {
        if (this.delegate?.saveIfDirty) {
            await this.delegate.saveIfDirty(uri);
        }
    }

    public getOpenDocumentText(uri: Uri): string | undefined {
        if (this.delegate?.getOpenDocumentText) {
            return this.delegate.getOpenDocumentText(uri);
        }
        return undefined;
    }

    public getActiveDocumentUri(): Uri | undefined {
        return this.delegate?.getActiveDocumentUri?.();
    }

    public getActiveDocumentSelections(): readonly TextSelectionRange[] | undefined {
        return this.delegate?.getActiveDocumentSelections?.();
    }

    public getOpenDocumentUris(): Uri[] {
        return this.delegate?.getOpenDocumentUris?.() ?? [];
    }

    public getOpenDiffTabs(): readonly HostDiffTab[] {
        return this.delegate?.getOpenDiffTabs?.() ?? [];
    }
}

export class WebHostStorage implements HostStorage {
    private readonly inMemoryStore = new Map<string, unknown>();
    private readonly _onDidChange = new EventEmitter<HostStorageChangeEvent>();

    private readonly _listenerDisposable?: { dispose: () => void };

    public readonly onDidChange: Event<HostStorageChangeEvent> = this._onDidChange.event;

    constructor(private readonly _hostSystem?: RemoteHostSystem) {
        if (this._hostSystem && typeof this._hostSystem.onStateDidChange === 'function') {
            this._listenerDisposable = this._hostSystem.onStateDidChange((key) => {
                this._onDidChange.fire({ key });
            });
        }
    }

    public dispose(): void {
        this._listenerDisposable?.dispose();
        this._onDidChange.dispose();
    }

    public async get<T>(key: string): Promise<T | undefined>;
    public async get<T>(key: string, defaultValue: T): Promise<T>;
    public async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
        if (this._hostSystem) {
            try {
                const val = await this._hostSystem.getState<T>(key);
                if (val !== undefined) {
                    return val;
                }
            } catch (err) {
                console.warn(`[WebHostStorage] Failed to read state key '${key}':`, err);
            }
            return defaultValue;
        }
        if (this.inMemoryStore.has(key)) {
            return this.inMemoryStore.get(key) as T;
        }
        return defaultValue;
    }

    public async update(key: string, value: unknown): Promise<void> {
        if (this._hostSystem) {
            if (value === undefined) {
                await this._hostSystem.deleteState(key);
            } else {
                await this._hostSystem.setState(key, value);
            }
            this._onDidChange.fire({ key });
            return;
        }
        if (value === undefined) {
            this.inMemoryStore.delete(key);
        } else {
            this.inMemoryStore.set(key, value);
        }
        this._onDidChange.fire({ key });
    }
}

export class WebHostSecrets implements HostSecrets {
    private readonly inMemorySecrets = new Map<string, string>();
    private readonly _onDidChange = new EventEmitter<HostSecretsChangeEvent>();
    private readonly _listenerDisposable?: { dispose: () => void };

    public readonly onDidChange: Event<HostSecretsChangeEvent> = this._onDidChange.event;

    constructor(private readonly _hostSystem?: RemoteHostSystem) {
        if (this._hostSystem && typeof this._hostSystem.onSecretsDidChange === 'function') {
            this._listenerDisposable = this._hostSystem.onSecretsDidChange((key) => {
                this._onDidChange.fire({ key });
            });
        }
    }

    public dispose(): void {
        this._listenerDisposable?.dispose();
        this._onDidChange.dispose();
    }

    public async get(key: string): Promise<string | undefined> {
        if (this._hostSystem) {
            try {
                return await this._hostSystem.getSecret(key);
            } catch (err) {
                console.warn(`[WebHostSecrets] Failed to get secret '${key}':`, err);
                return undefined;
            }
        }
        return this.inMemorySecrets.get(key);
    }

    public async store(key: string, value: string): Promise<void> {
        if (this._hostSystem) {
            await this._hostSystem.storeSecret(key, value);
            this._onDidChange.fire({ key });
            return;
        }
        this.inMemorySecrets.set(key, value);
        this._onDidChange.fire({ key });
    }

    public async delete(key: string): Promise<void> {
        if (this._hostSystem) {
            await this._hostSystem.deleteSecret(key);
            this._onDidChange.fire({ key });
            return;
        }
        this.inMemorySecrets.delete(key);
        this._onDidChange.fire({ key });
    }
}

export class WebHostAuth implements HostAuth {
    public async getSession(
        _providerId: string,
        _scopes: string[],
        _options?: { silent?: boolean; createIfNone?: boolean; forceNewSession?: boolean },
    ): Promise<HostAuthSession | undefined> {
        return undefined;
    }
}

export class WebHostCommands implements HostCommands {
    private readonly commandMap = new Map<string, (...args: never[]) => unknown>();
    private contextKeySetter: ContextKeySetter | undefined;

    public setContextKeySetter(setter: ContextKeySetter | undefined): void {
        this.contextKeySetter = setter;
    }

    public registerCommand<T extends (...args: never[]) => unknown>(commandId: string, callback: T): HostDisposable {
        this.commandMap.set(commandId, callback);
        return {
            dispose: () => {
                this.commandMap.delete(commandId);
            },
        };
    }

    public hasCommand(commandId: string): boolean {
        return this.commandMap.has(commandId);
    }

    public getRegisteredCommands(): string[] {
        return Array.from(this.commandMap.keys());
    }

    public async executeCommand<R = unknown>(commandId: string, ...args: unknown[]): Promise<R> {
        const handler = this.commandMap.get(commandId);
        if (handler) {
            return (await handler(...(args as never[]))) as R;
        }
        return undefined as R;
    }

    public async setContextKey(key: string, value: unknown): Promise<void> {
        this.contextKeySetter?.set(key, value);
    }
}

export class WebHostViews implements HostViews {
    public registerWebviewViewProvider(_viewId: string, _provider: unknown): HostDisposable {
        return { dispose: () => {} };
    }

    public registerCustomEditorProvider(_viewType: string, _provider: unknown, _options?: unknown): HostDisposable {
        return { dispose: () => {} };
    }

    public registerFileSystemProvider(
        _scheme: string,
        _provider: unknown,
        _options?: { isReadonly?: boolean },
    ): HostDisposable {
        return { dispose: () => {} };
    }

    public registerFileDecorationProvider(_provider: unknown): HostDisposable {
        return { dispose: () => {} };
    }
}

export class WebHostWorkspace implements HostWorkspace {
    private readonly _onDidChangeWorkspaceFolders = new EventEmitter<HostWorkspaceFoldersChangeEvent>();
    public readonly onDidChangeWorkspaceFolders = this._onDidChangeWorkspaceFolders.event;

    constructor(
        public readonly workspaceFolders: readonly HostWorkspaceFolder[] = [],
        private readonly hostSystem?: RemoteHostSystem,
        private readonly hostConfig?: HostConfig,
    ) {}

    public async findFiles(pattern: string, baseFolderUri?: Uri, maxResults?: number): Promise<Uri[]> {
        if (!this.hostSystem) {
            return [];
        }

        const baseDir = baseFolderUri?.fsPath ?? this.workspaceFolders[0]?.uri.fsPath ?? this.hostSystem.repoRoot;
        if (!baseDir) {
            return [];
        }

        const excludes: string[] = [];

        // 1. files.exclude from config
        const filesExclude = this.hostConfig?.get<Record<string, boolean>>('files.exclude');
        if (filesExclude) {
            for (const [k, v] of Object.entries(filesExclude)) {
                if (v) {
                    excludes.push(k);
                }
            }
        }

        // 2. search.exclude from config
        const searchExclude = this.hostConfig?.get<Record<string, boolean>>('search.exclude');
        if (searchExclude) {
            for (const [k, v] of Object.entries(searchExclude)) {
                if (v) {
                    excludes.push(k);
                }
            }
        }

        // 3. ignoredRepositories from config
        const ignoredRepos = this.hostConfig?.get<string[]>('ignoredRepositories');
        if (ignoredRepos && Array.isArray(ignoredRepos)) {
            excludes.push(...ignoredRepos);
        }

        // 4. Loosely check .gitignore in baseDir (skip when searching for repository markers like .jj)
        const isRepoDiscovery = pattern.includes('.jj');
        if (!isRepoDiscovery) {
            try {
                const gitIgnorePath = `${baseDir.replace(/[/\\]+$/, '')}/.gitignore`;
                const content = await this.hostSystem.fs.readTextFile(gitIgnorePath);
                const lines = content.split(/\r?\n/);
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.length > 0 && !trimmed.startsWith('#') && !trimmed.startsWith('!')) {
                        const clean = trimmed.replace(/^\/+|\/+$/g, '');
                        if (clean.length > 0 && !excludes.includes(clean)) {
                            excludes.push(clean);
                        }
                    }
                }
            } catch {
                // Ignore missing .gitignore
            }
        }

        const files = await this.hostSystem.findFiles(pattern, baseDir, maxResults, excludes);
        return files.map((f) => UriImpl.file(f));
    }
}

export class WebHostEnvironment implements HostEnvironment {
    public readonly quickInput: QuickInputService;
    public readonly notifications: NotificationService;
    public readonly statusBar: StatusBarService;
    public readonly ui: WebHostUi;
    public readonly nav: WebHostNavigation;
    public readonly config: WebHostConfig;
    public readonly documents: WebHostDocuments;
    public readonly storage: WebHostStorage;
    public readonly secrets: WebHostSecrets;
    public readonly auth: HostAuth = new WebHostAuth();
    public readonly commands: WebHostCommands = new WebHostCommands();
    public readonly views: HostViews = new WebHostViews();
    public readonly workspace: HostWorkspace;
    public readonly extensions: HostExtensions = { hasExtension: () => false };
    public readonly system: RemoteHostSystem;

    constructor(
        hostSystem: RemoteHostSystem,
        repoRoot: string,
        navCallbacks?: WebHostNavigationCallbacks,
        quickInputService?: QuickInputService,
        notificationService?: NotificationService,
        statusBarService?: StatusBarService,
    ) {
        this.system = hostSystem;
        this.storage = new WebHostStorage(hostSystem);
        this.secrets = new WebHostSecrets(hostSystem);
        this.nav = new WebHostNavigation(navCallbacks);
        this.config = new WebHostConfig(hostSystem);
        this.documents = new WebHostDocuments(hostSystem);
        this.quickInput = quickInputService ?? new QuickInputService();
        this.notifications = notificationService ?? new NotificationService();
        this.statusBar = statusBarService ?? new StatusBarService();
        this.ui = new WebHostUi(this.quickInput, this.notifications, this.statusBar);

        // Configure notification position from settings if defined
        const configuredPos = this.config.get<NotificationPosition>('notificationPosition');
        if (configuredPos) {
            this.notifications.setPosition(configuredPos);
        }
        this.config.onDidChangeConfiguration?.((e) => {
            if (e.affectsConfiguration('notificationPosition')) {
                const pos = this.config.get<NotificationPosition>('notificationPosition');
                if (pos) {
                    this.notifications.setPosition(pos);
                }
            }
        });

        const folderName =
            repoRoot
                .replace(/[/\\]+$/, '')
                .split(/[/\\]/)
                .pop() || 'Workspace';
        this.workspace = new WebHostWorkspace(
            [
                {
                    uri: UriImpl.file(repoRoot),
                    name: folderName,
                },
            ],
            this.system,
            this.config,
        );
    }

    public dispose(): void {
        this.storage.dispose?.();
        this.secrets.dispose?.();
        this.ui.dispose();
    }
}
