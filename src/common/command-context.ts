/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommentsManager } from '../comments-manager';
import type { JjRepository } from '../jj-repository';
import type { Uri } from '../uri-utils';
import type { JjLoggerChannel } from '../utils/output-channel';

export interface CommandUI {
    showInputBox(options?: {
        prompt?: string;
        value?: string;
        placeHolder?: string;
        validateInput?: (value: string) => string | null | undefined | Promise<string | null | undefined>;
    }): Promise<string | undefined>;
    showQuickPick<T extends { label: string; value?: unknown }>(
        items: T[],
        options?: { placeHolder?: string },
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
    promptForRevision(options?: { placeHolder?: string; revisionQuery?: string }): Promise<string | undefined>;
    withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
}

export interface CommandConfig {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
}

export interface CommandNavigation {
    openDiff(leftUri: Uri, rightUri: Uri, title: string): Promise<void>;
    openMultiDiff(title: string, resources: { leftUri: Uri; rightUri: Uri; label: string }[]): Promise<void>;
    openFile(uri: Uri): Promise<void>;
    openFolder(folderUri: Uri, forceNewWindow?: boolean): Promise<void>;
    openExternal(url: string): Promise<void>;
    copyToClipboard(text: string): Promise<void>;
    openSettings(settingId?: string): Promise<void>;
    focusScmInput?(): Promise<void>;
}

export interface CommandServices {
    commentsManager?: CommentsManager;
}

export interface CommandContext {
    readonly repo: JjRepository;
    readonly ui: CommandUI;
    readonly config: CommandConfig;
    readonly nav: CommandNavigation;
    readonly log: JjLoggerChannel;
    readonly services: CommandServices;
}
