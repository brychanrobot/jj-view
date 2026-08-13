/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import { promptForRevision, showJjError, withDelayedProgress } from '../commands/command-utils';
import type { CommentsManager } from '../comments-manager';
import type {
    CommandConfig,
    CommandContext,
    CommandNavigation,
    CommandServices,
    CommandUI,
} from '../common/command-context';
import type { JjRepository } from '../jj-repository';
import type { Uri } from '../uri-utils';
import { getJjViewConfig } from '../utils/config-utils';
import type { JjLoggerChannel } from '../utils/output-channel';

export class VSCodeCommandUI implements CommandUI {
    constructor(
        private readonly repo: JjRepository,
        private readonly log: JjLoggerChannel,
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
        options?: { placeHolder?: string },
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
        return await showJjError(error, prefix, this.repo.jj, this.log, extraActions);
    }

    async promptForRevision(options?: { placeHolder?: string; revisionQuery?: string }): Promise<string | undefined> {
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
}

export class VSCodeCommandConfig implements CommandConfig {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        return getJjViewConfig<T>(key, defaultValue) ?? defaultValue;
    }
}

export class VSCodeCommandNavigation implements CommandNavigation {
    async openDiff(leftUri: Uri, rightUri: Uri, title: string): Promise<void> {
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    }

    async openMultiDiff(title: string, resources: { leftUri: Uri; rightUri: Uri; label: string }[]): Promise<void> {
        // vscode.changes expects 3-tuples of [labelUri, leftUri, rightUri] where labelUri is the target resource URI
        const changes = resources.map((r) => [r.rightUri, r.leftUri, r.rightUri]);
        await vscode.commands.executeCommand('vscode.changes', title, changes);
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

export class VSCodeCommandContext implements CommandContext {
    readonly ui: CommandUI;
    readonly config: CommandConfig;
    readonly nav: CommandNavigation;
    readonly services: CommandServices;

    constructor(
        readonly repo: JjRepository,
        readonly log: JjLoggerChannel,
        commentsManager: CommentsManager,
    ) {
        this.ui = new VSCodeCommandUI(repo, log);
        this.config = new VSCodeCommandConfig();
        this.nav = new VSCodeCommandNavigation();
        this.services = { commentsManager };
    }
}
