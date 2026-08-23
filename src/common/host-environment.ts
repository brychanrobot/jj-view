/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Uri } from '../uri-utils';

export interface HostDisposable {
    dispose(): void;
}

export interface HostUi {
    showInputBox(options?: {
        prompt?: string;
        value?: string;
        placeHolder?: string;
        validateInput?: (value: string) => string | null | undefined | Promise<string | null | undefined>;
    }): Promise<string | undefined>;
    showQuickPick<T extends { label: string; value?: unknown }>(
        items: T[],
        options?: { placeHolder?: string; title?: string },
    ): Promise<T | undefined>;
    showMultiQuickPick<T extends { label: string; value?: unknown }>(
        items: T[],
        options?: { placeHolder?: string },
    ): Promise<T[] | undefined>;
    showInformation(message: string, ...actions: string[]): Promise<string | undefined>;
    showWarning(
        message: string,
        optionsOrAction?: { modal?: boolean } | string,
        ...actions: string[]
    ): Promise<string | undefined>;
    showError(error: unknown, prefix: string, extraActions?: string[]): Promise<string | undefined>;
    promptForRevision(options?: {
        placeHolder?: string;
        revisionQuery?: string;
        emptyPrompt?: string;
    }): Promise<string | undefined>;
    promptSelectOrCreate(options: {
        placeHolder?: string;
        items: { label: string; description?: string }[];
    }): Promise<string | undefined>;
    withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
    setStatusBarMessage?(message: string, timeoutMs?: number): void;
    setScmDescriptionInputValue?(value: string): void;
    getScmDescriptionInputValue?(): string | undefined;
}

export interface HostConfig {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update?<T>(key: string, value: T): Promise<void>;
}

export interface HostNavigation {
    openDiff(leftUri: Uri, rightUri: Uri, title: string): Promise<void>;
    openMultiDiff(title: string, resources: { leftUri: Uri; rightUri: Uri; label: string }[]): Promise<void>;
    openMergeEditor(resourceUri: Uri): Promise<void>;
    openCommitDetails(
        repoRoot: string,
        changeId: string,
        shortestChangeId?: string,
        isDivergent?: boolean,
        changeIdOffset?: number,
    ): Promise<void>;
    openFile(uri: Uri): Promise<void>;
    openFolder(folderUri: Uri, forceNewWindow?: boolean): Promise<void>;
    openExternal(url: string): Promise<void>;
    copyToClipboard(text: string): Promise<void>;
    openSettings(settingId?: string): Promise<void>;
    focusScmInput?(): Promise<void>;
    closeTab(uri: Uri): Promise<void>;
}

export interface HostDocuments {
    readLineRangeText(uri: Uri, startLine1Based: number, endLine1Based: number): Promise<string>;
    replaceLineRangeAndSave(
        uri: Uri,
        lineRange: { startLine1Based: number; endLine1Based: number },
        replacementText: string,
    ): Promise<void>;
    saveIfDirty(uri: Uri): Promise<void>;
    getOpenDocumentText(uri: Uri): string | undefined;
}

export interface HostStorage {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Promise<void>;
}

export interface HostSecrets {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface HostAuthSession {
    readonly id: string;
    readonly accessToken: string;
    readonly account: { readonly label: string; readonly id: string };
    readonly scopes: readonly string[];
}

export interface HostAuth {
    getSession(
        providerId: string,
        scopes: string[],
        options?: { silent?: boolean; createIfNone?: boolean },
    ): Promise<HostAuthSession | undefined>;
}

export interface HostCommands {
    registerCommand<T extends (...args: never[]) => unknown>(commandId: string, callback: T): HostDisposable;
    executeCommand<R = unknown>(commandId: string, ...args: unknown[]): Promise<R>;
    setContextKey?(key: string, value: unknown): Promise<void>;
}

export interface HostViews {
    registerWebviewViewProvider(viewId: string, provider: unknown): HostDisposable;
    registerCustomEditorProvider(viewType: string, provider: unknown, options?: unknown): HostDisposable;
    registerFileSystemProvider(scheme: string, provider: unknown, options?: { isReadonly?: boolean }): HostDisposable;
    registerFileDecorationProvider(provider: unknown): HostDisposable;
}

export interface HostEnvironment {
    readonly ui: HostUi;
    readonly nav: HostNavigation;
    readonly config: HostConfig;
    readonly documents: HostDocuments;
    readonly storage?: HostStorage;
    readonly secrets?: HostSecrets;
    readonly auth?: HostAuth;
    readonly commands?: HostCommands;
    readonly views?: HostViews;
}
