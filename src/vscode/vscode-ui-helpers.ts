/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractUriFromArgs, getErrorMessage } from '../commands/command-utils';
import type { JjRepository } from '../jj-repository';
import type { JjRepositoryManager } from '../jj-repository-manager';
import { JjService } from '../jj-service';
import { createCommitDetailsUri, getUriParams, Uri } from '../uri-utils';
import { getJjViewConfig } from '../utils/config-utils';
import { formatCommitTitle } from '../utils/jj-utils';
import type { JjLoggerChannel } from '../utils/output-channel';
import type { VsCodeScmProvider } from './providers/vscode-scm-provider';

function isSourceControlResourceGroup(arg: unknown): arg is vscode.SourceControlResourceGroup {
    return typeof arg === 'object' && arg !== null && 'id' in arg && 'resourceStates' in arg;
}

export async function promptForRevision(
    jj: JjService,
    options?: { placeHolder?: string; revisionQuery?: string; emptyPrompt?: string },
): Promise<string | undefined> {
    const placeHolder = options?.placeHolder ?? 'Select target revision';
    const revisionQuery = options?.revisionQuery ?? 'all()';
    const emptyPrompt = options?.emptyPrompt ?? 'Enter revision';
    const limit = 200;

    try {
        const commitIds = await jj.getLogIds({
            revision: revisionQuery,
            limit,
        });

        const entries = await Promise.all(commitIds.map((id) => jj.getLog({ revision: id })));
        const ancestors = entries.map((e) => e[0]).filter(Boolean);

        const items: vscode.QuickPickItem[] = ancestors.map((entry) => {
            const shortId = entry.change_id_shortest || entry.change_id.substring(0, 8);
            const desc = entry.description?.trim() || '(no description)';
            const shortDesc = desc.split('\n')[0].substring(0, 50);

            let bookmarkStr = '';
            if (entry.bookmarks && entry.bookmarks.length > 0) {
                bookmarkStr = ` (${entry.bookmarks.map((b) => b.name).join(', ')})`;
            }

            return {
                label: `${shortId}${bookmarkStr}`,
                description: shortDesc,
                detail: entry.change_id,
            };
        });

        if (items.length === 0) {
            return await vscode.window.showInputBox({
                prompt: `${emptyPrompt} (no ancestors found)`,
                placeHolder: 'e.g. main, @-',
            });
        }

        const selected = await new Promise<string | undefined>((resolve) => {
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = items;
            quickPick.placeholder = placeHolder;
            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail = true;

            quickPick.onDidAccept(() => {
                const selectedItem = quickPick.activeItems[0] || quickPick.selectedItems[0];
                if (selectedItem) {
                    resolve(selectedItem.detail);
                } else if (quickPick.value.trim()) {
                    resolve(quickPick.value.trim());
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

        if (!selected) {
            return undefined;
        }

        return selected;
    } catch {
        return await vscode.window.showInputBox({
            prompt: emptyPrompt,
            placeHolder: 'e.g. main, @-',
        });
    }
}

export async function withDelayedProgress<T>(title: string, promise: Promise<T>): Promise<T> {
    const DELAY_MS = 100;

    let notificationResolver: ((value?: unknown) => void) | undefined;
    const notificationComplete = new Promise((resolve) => {
        notificationResolver = resolve;
    });

    const timer = setTimeout(() => {
        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: title,
                cancellable: false,
            },
            async () => {
                await notificationComplete;
            },
        );
    }, DELAY_MS);

    try {
        return await promise;
    } finally {
        clearTimeout(timer);
        if (notificationResolver) {
            notificationResolver();
        }
    }
}

export async function showJjError(
    error: unknown,
    prefix: string,
    jj?: JjService,
    outputChannel?: JjLoggerChannel,
    extraActions: string[] = [],
): Promise<string | undefined> {
    const message = getErrorMessage(error);
    let fullMessage = `${prefix}: ${message}`;

    const isLockError = JjService.isIndexLockError(error);
    const DELETE_LOCK = 'Delete Lock File';
    let lockPath: string | undefined;

    if (isLockError && jj) {
        try {
            const repoRoot = await jj.getRepoRoot();
            lockPath = path.join(repoRoot, '.git', 'index.lock');
            fullMessage = `${prefix}: Git index is locked. Another process may have crashed. Delete .git/index.lock to resolve.`;
            if (!extraActions.includes(DELETE_LOCK)) {
                extraActions = [DELETE_LOCK, ...extraActions];
            }
        } catch (_) {
            // Ignore if we can't figure out the repo root
        }
    }

    if (!process.env.VITEST) {
        console.error(fullMessage, error);
    }
    outputChannel?.error(`[Error] ${fullMessage}`);

    const SHOW_LOG = 'Show Log';
    const selection = await vscode.window.showErrorMessage(fullMessage, SHOW_LOG, ...extraActions);

    if (selection === SHOW_LOG) {
        outputChannel?.show();
    } else if (selection === DELETE_LOCK && lockPath) {
        try {
            await fs.unlink(lockPath);
            outputChannel?.info(`[Info] Deleted lock file at ${lockPath}`);
        } catch (e) {
            outputChannel?.error(`[Error] Failed to delete lock file: ${getErrorMessage(e)}`);
            vscode.window.showErrorMessage(`Failed to delete lock file: ${getErrorMessage(e)}`);
        }
    }
    return selection;
}

export function resolveRepository(
    args: unknown[],
    repositoryManager: JjRepositoryManager,
    scmProviders: Map<string, VsCodeScmProvider>,
): { repo?: JjRepository; scm?: VsCodeScmProvider } | undefined {
    const firstArg = args[0];

    // 1. Check if first arg is a VS Code SourceControlResourceGroup owned by one of our providers
    if (firstArg && isSourceControlResourceGroup(firstArg)) {
        for (const scmProvider of scmProviders.values()) {
            if (scmProvider.ownsGroup(firstArg)) {
                return { repo: scmProvider.repo, scm: scmProvider };
            }
        }
    }

    let uri: Uri | undefined;

    // 2. Check if first arg is a VS Code SourceControl object
    if (firstArg && typeof firstArg === 'object' && firstArg !== null && 'rootUri' in firstArg) {
        const scmObj = firstArg as { rootUri: unknown };
        if (Uri.isUri(scmObj.rootUri)) {
            uri = scmObj.rootUri;
        }
    }

    if (!uri) {
        uri = extractUriFromArgs(args);
        if (uri) {
            repositoryManager.outputChannel.info(
                `[resolveRepository] Extracted candidate URI from arguments: ${uri.toString()}`,
            );
        }
    }

    // 3. Check active editor document URI (handles file tabs and jj-commit custom editor)
    if (!uri) {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const docUri = activeEditor.document.uri;
            if (docUri.scheme === 'jj-commit') {
                const query = getUriParams(docUri);
                const repoRoot = query.get('repoRoot');
                if (repoRoot) {
                    uri = Uri.file(decodeURIComponent(repoRoot));
                    repositoryManager.outputChannel.info(
                        `[resolveRepository] Resolved candidate URI from active jj-commit editor repoRoot: ${uri.toString()}`,
                    );
                }
            } else {
                uri = docUri;
                repositoryManager.outputChannel.info(
                    `[resolveRepository] Resolved candidate URI from active text editor: ${uri.toString()}`,
                );
            }
        }
    }

    // 4. Resolve repository and scm from candidate URI, or fallback to focused repository
    let repo = uri ? repositoryManager.getRepositoryForUri(uri) : undefined;
    if (repo) {
        repositoryManager.outputChannel.info(
            `[resolveRepository] Successfully resolved repository for URI: ${repo.rootUri.fsPath}`,
        );
    } else {
        if (uri) {
            repositoryManager.outputChannel.info(
                `[resolveRepository] No repository matched candidate URI: ${uri.toString()}`,
            );
        }
        repo = repositoryManager.focusedRepository;
        if (repo) {
            repositoryManager.outputChannel.info(
                `[resolveRepository] Fallback to focused repository: ${repo.rootUri.fsPath}`,
            );
        } else {
            repositoryManager.outputChannel.info(`[resolveRepository] No repository resolved.`);
        }
    }

    if (!repo) {
        return undefined;
    }

    let scm: VsCodeScmProvider | undefined;
    if (repo) {
        scm = scmProviders.get(repo.rootUri.fsPath);
    }

    return { repo, scm };
}

/**
 * Closes all tabs in the workspace that match the given predicate.
 */
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

/**
 * Closes commit details custom editor tabs matching the given repository root predicate.
 */
export async function closeCommitDetailsTabs(
    predicate: (repoRoot?: string) => boolean,
    viewType: string = 'jj-view.commitDetailsEditor',
): Promise<void> {
    await closeMatchingTabs((tab) => {
        if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.viewType !== viewType) {
            return false;
        }
        try {
            const query = getUriParams(tab.input.uri);
            const repoRoot = query.get('repoRoot') || undefined;
            return predicate(repoRoot);
        } catch {
            return predicate(undefined);
        }
    });
}

/**
 * Closes other commit details custom editor tabs for the given workspace root.
 */
export async function closeOtherCommitDetailsTabs(
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

/**
 * Opens the custom editor for commit details.
 */
export async function openCommitDetails(
    repoRoot: string,
    changeId: string,
    changeIdShortest?: string,
    isDivergent?: boolean,
    changeIdOffset?: number,
): Promise<void> {
    const minLength = getJjViewConfig<number>('minChangeIdLength', 1) ?? 1;
    const title = formatCommitTitle(
        {
            change_id: changeId,
            change_id_shortest: changeIdShortest,
            is_divergent: isDivergent,
            change_id_offset: changeIdOffset,
        },
        minLength,
    );

    const uri = createCommitDetailsUri({
        repoRoot,
        changeId,
        title,
    });

    await closeOtherCommitDetailsTabs(uri, repoRoot);

    await vscode.commands.executeCommand('vscode.openWith', uri, 'jj-view.commitDetailsEditor', {
        preview: true,
        viewColumn: vscode.ViewColumn.Active,
    });
}
