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
} from '../../../src/core/host/host-environment';
import type { RemoteHostSystem } from '../../../src/core/host/remote-host-system';
import type { Uri } from '../../../src/core/uri-utils';
import { Uri as UriImpl } from '../../../src/core/uri-utils';
import { NotificationService } from '../notifications/notification-service';
import type { NotificationPosition } from '../notifications/notification-types';
import { QuickInputService } from '../quick-input/quick-input-service';
import { StatusBarService } from '../status/status-bar-service';

export interface WebHostNavigationCallbacks {
    onOpenDiff?: (leftUri: Uri, rightUri: Uri, title: string) => Promise<void> | void;
    onOpenFile?: (uri: Uri) => Promise<void> | void;
    onOpenMergeEditor?: (resourceUri: Uri) => Promise<void> | void;
    onOpenCommitDetails?: (changeId: string) => Promise<void> | void;
    onFocusScmInput?: () => Promise<void> | void;
    onOpenSettings?: (settingId?: string) => Promise<void> | void;
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

    public async getScoped<T>(key: string, scope: 'user' | 'workspace'): Promise<T | undefined> {
        if (!this._hostSystem || typeof this._hostSystem.getConfig !== 'function') {
            return this.get<T>(key);
        }
        return this._hostSystem.getConfig<T>(key, scope);
    }

    public async getAllScoped(scope: 'user' | 'workspace'): Promise<Record<string, unknown>> {
        if (!this._hostSystem || typeof this._hostSystem.getAllConfig !== 'function') {
            return Object.fromEntries(this.values.entries());
        }
        return this._hostSystem.getAllConfig(scope);
    }
}

export class WebHostNavigation implements HostNavigation {
    private callbacks: WebHostNavigationCallbacks;

    constructor(callbacks: WebHostNavigationCallbacks = {}) {
        this.callbacks = callbacks;
    }

    public setCallbacks(callbacks: WebHostNavigationCallbacks): void {
        this.callbacks = callbacks;
    }

    public async openDiff(leftUri: Uri, rightUri: Uri, title: string): Promise<void> {
        if (this.callbacks.onOpenDiff) {
            await this.callbacks.onOpenDiff(leftUri, rightUri, title);
        }
    }

    public async openMultiDiff(
        _title: string,
        _resources: { leftUri: Uri; rightUri: Uri; label: string }[],
    ): Promise<void> {
        // Multi-diff not supported in single view
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
    ): Promise<void> {
        if (this.callbacks.onOpenCommitDetails) {
            await this.callbacks.onOpenCommitDetails(changeId);
        }
    }

    public async focusScmInput(): Promise<void> {
        if (this.callbacks.onFocusScmInput) {
            await this.callbacks.onFocusScmInput();
        }
    }

    public async openFile(uri: Uri): Promise<void> {
        if (this.callbacks.onOpenFile) {
            await this.callbacks.onOpenFile(uri);
        }
    }

    public async openFolder(_folderUri: Uri, _forceNewWindow?: boolean): Promise<void> {}

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

    public async closeTab(_uri: Uri): Promise<void> {}
}

export class WebHostDocuments implements HostDocuments {
    constructor(private readonly hostSystem: RemoteHostSystem) {}

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
    }

    public async saveIfDirty(_uri: Uri): Promise<void> {}

    public getOpenDocumentText(_uri: Uri): string | undefined {
        return undefined;
    }
}

export class WebHostStorage implements HostStorage {
    private readonly store = new Map<string, unknown>();

    public get<T>(key: string): T | undefined;
    public get<T>(key: string, defaultValue: T): T;
    public get<T>(key: string, defaultValue?: T): T | undefined {
        if (this.store.has(key)) {
            return this.store.get(key) as T;
        }
        return defaultValue;
    }

    public async update(key: string, value: unknown): Promise<void> {
        this.store.set(key, value);
    }
}

export class WebHostSecrets implements HostSecrets {
    private readonly secrets = new Map<string, string>();

    public async get(key: string): Promise<string | undefined> {
        return this.secrets.get(key);
    }

    public async store(key: string, value: string): Promise<void> {
        this.secrets.set(key, value);
    }

    public async delete(key: string): Promise<void> {
        this.secrets.delete(key);
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

    constructor(public readonly workspaceFolders: readonly HostWorkspaceFolder[] = []) {}
}

export class WebHostEnvironment implements HostEnvironment {
    public readonly quickInput: QuickInputService;
    public readonly notifications: NotificationService;
    public readonly statusBar: StatusBarService;
    public readonly ui: WebHostUi;
    public readonly nav: WebHostNavigation;
    public readonly config: WebHostConfig;
    public readonly documents: HostDocuments;
    public readonly storage: HostStorage = new WebHostStorage();
    public readonly secrets: HostSecrets = new WebHostSecrets();
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
        this.workspace = new WebHostWorkspace([
            {
                uri: UriImpl.file(repoRoot),
                name: folderName,
            },
        ]);
    }

    public dispose(): void {
        this.ui.dispose();
    }
}
