/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ScmContextValue } from '../jj-context-keys';
import type { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import type { JjResourceState } from '../scm-resource-state';
import { formatCommitDescription } from '../utils/format-utils';

// Internal type guards to keep the messy VS Code argument matching encapsulated

function hasResourceUri(arg: unknown): arg is { resourceUri: vscode.Uri } {
    return typeof arg === 'object' && arg !== null && 'resourceUri' in arg;
}

function hasResourceStates(arg: unknown): arg is { resourceStates: unknown[] } {
    if (typeof arg !== 'object' || arg === null || !('resourceStates' in arg)) {
        return false;
    }
    const obj = arg as { resourceStates: unknown };
    return Array.isArray(obj.resourceStates);
}

function hasRevision(arg: unknown): arg is { revision: string } | { 'jj.revision': string } {
    if (typeof arg !== 'object' || arg === null) {
        return false;
    }
    const obj = arg as Record<string, unknown>;
    return typeof obj.revision === 'string' || typeof obj['jj.revision'] === 'string';
}

function hasCommitId(arg: unknown): arg is { commitId: string } | { 'jj.commitId': string } {
    if (typeof arg !== 'object' || arg === null) {
        return false;
    }
    const obj = arg as Record<string, unknown>;
    return typeof obj.commitId === 'string' || typeof obj['jj.commitId'] === 'string';
}

function hasChangeId(arg: unknown): arg is { changeId: string } | { 'jj.changeId': string } {
    if (typeof arg !== 'object' || arg === null) {
        return false;
    }
    const obj = arg as Record<string, unknown>;
    return typeof obj.changeId === 'string' || typeof obj['jj.changeId'] === 'string';
}

/**
 * Standardizes the extraction of JjResourceStates from the various ways
 * VS Code passes arguments to commands (command palette, context menu, etc).
 *
 * @param args The variadic arguments passed to the command handler
 * @returns An array of JjResourceState objects representing the selected files/resources
 */
export function collectResourceStates(args: unknown[]): JjResourceState[] {
    const resourceStates: JjResourceState[] = [];

    const processArg = (arg: unknown) => {
        if (!arg) {
            return;
        }

        if (Array.isArray(arg)) {
            arg.forEach(processArg);
        } else if (hasResourceUri(arg)) {
            // Context Menu: Resource State
            resourceStates.push(arg as JjResourceState);
        } else if (hasResourceStates(arg)) {
            // Context Menu: Resource Group (e.g. "Working Copy" header)
            arg.resourceStates.forEach(processArg);
        }
    };

    args.forEach(processArg);

    // De-duplicate by fsPath
    const unique = new Map<string, JjResourceState>();
    for (const state of resourceStates) {
        unique.set(state.resourceUri.fsPath, state);
    }

    const result = Array.from(unique.values());
    return result;
}

function isSourceControlResourceGroup(arg: unknown): arg is vscode.SourceControlResourceGroup {
    return typeof arg === 'object' && arg !== null && 'id' in arg && 'label' in arg && 'resourceStates' in arg;
}

export function isCurrentWorkingCopyResourceGroup(arg: unknown): arg is vscode.SourceControlResourceGroup {
    return isSourceControlResourceGroup(arg) && arg.id === ScmContextValue.WorkingCopyGroup;
}

export function isParentResourceGroup(arg: unknown): arg is vscode.SourceControlResourceGroup {
    return isSourceControlResourceGroup(arg) && arg.id.startsWith('ancestor-');
}

function isJjResourceState(arg: unknown): arg is JjResourceState {
    return typeof arg === 'object' && arg !== null && 'resourceUri' in arg && 'revision' in arg;
}

/**
 * Helper to extract revisions from various VS Code argument types.
 * Supports strings, objects with revision/commitId, and resource groups.
 */
export function extractRevisions(args: unknown[]): string[] {
    const revisions: string[] = [];

    for (const arg of args) {
        if (!arg) {
            continue;
        }

        if (typeof arg === 'string' && arg.trim().length > 0) {
            revisions.push(arg);
            continue;
        }

        if (hasRevision(arg)) {
            const val = 'revision' in arg ? arg.revision : arg['jj.revision'];
            revisions.push(val);
            continue;
        }

        if (hasChangeId(arg)) {
            const val = 'changeId' in arg ? arg.changeId : arg['jj.changeId'];
            revisions.push(val);
            continue;
        }

        if (hasCommitId(arg)) {
            const val = 'commitId' in arg ? arg.commitId : arg['jj.commitId'];
            revisions.push(val);
            continue;
        }

        if (isCurrentWorkingCopyResourceGroup(arg)) {
            revisions.push('@');
            continue;
        }
        if (isJjResourceState(arg)) {
            revisions.push(arg.revision);
            continue;
        }

        if (isParentResourceGroup(arg) && arg.resourceStates.length > 0) {
            // Revisions for all files in this group (they should all be the same commit)
            const groupRevisions = (arg.resourceStates as JjResourceState[])
                .map((s) => s.revision)
                .filter((v, i, a) => a.indexOf(v) === i);
            revisions.push(...groupRevisions);
            continue;
        }

        if (Array.isArray(arg)) {
            revisions.push(...extractRevisions(arg));
        }
    }

    const uniqueRevisions = Array.from(new Set(revisions));
    return uniqueRevisions;
}

/**
 * Helper to check if a specific revision was passed (singular).
 * Re-added for backward compatibility to keep independent command diffs small.
 */
export function extractRevision(args: unknown[]): string | undefined {
    const revs = extractRevisions(args);
    return revs.length > 0 ? revs[0] : undefined;
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/**
 * Prompts the user to select or type a revision.
 * Populates a QuickPick with the mutable ancestors of the target revision.
 */
export async function promptForRevision(
    jj: JjService,
    targetRevision: string = '@',
    placeHolder: string = 'Select a revision',
    emptyPrompt: string = 'Enter revision',
): Promise<string | undefined> {
    const maxMutableAncestors = vscode.workspace.getConfiguration('jj-view').get<number>('maxMutableAncestors', 10);
    const limit = maxMutableAncestors + 1;

    try {
        const commitIds = await jj.getLogIds({
            revision: `((::${targetRevision} & mutable()) | parents(roots(::${targetRevision} & mutable()))) ~ ${targetRevision}`,
            limit,
        });

        const entries = await Promise.all(commitIds.map((id) => jj.getLog({ revision: id })));
        const ancestors = entries.map((e) => e[0]).filter(Boolean);

        const options: vscode.QuickPickItem[] = ancestors.map((entry) => {
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

        if (options.length === 0) {
            return await vscode.window.showInputBox({
                prompt: `${emptyPrompt} (no ancestors found)`,
                placeHolder: 'e.g. main, @-',
            });
        }

        const selected = await new Promise<string | undefined>((resolve) => {
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = options;
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

/**
 * Wraps a promise with a delayed progress notification.
 * If the promise resolves within 100ms, no notification is shown.
 * If it takes longer, a progress notification appears until the promise resolves.
 */
export async function withDelayedProgress<T>(title: string, promise: Promise<T>): Promise<T> {
    const DELAY_MS = 100;

    let notificationResolver: ((value?: unknown) => void) | undefined;
    // Promise that resolves when the notification is dismissed (by the task finishing)
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
                // Wait for the original task to complete
                await notificationComplete;
            },
        );
    }, DELAY_MS);

    try {
        return await promise;
    } finally {
        clearTimeout(timer);
        // Signal the progress window to close if it was opened
        if (notificationResolver) {
            notificationResolver();
        }
    }
}

/**
 * Displays an error message to the user and logs full details to the output channel.
 * The message is shown as a non-modal (toast) notification which persists until dismissed.
 * A "Show Log" button is included to open the output channel.
 *
 * @returns The label of the button clicked by the user, or undefined if dismissed.
 */
export async function showJjError(
    error: unknown,
    prefix: string,
    jj: JjService,
    outputChannel?: vscode.OutputChannel,
    extraActions: string[] = [],
): Promise<string | undefined> {
    const message = getErrorMessage(error);
    let fullMessage = `${prefix}: ${message}`;

    const isLockError = JjService.isIndexLockError(error);
    const DELETE_LOCK = 'Delete Lock File';
    let lockPath: string | undefined;

    if (isLockError) {
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
    outputChannel?.appendLine(`[Error] ${fullMessage}`);

    const SHOW_LOG = 'Show Log';
    const selection = await vscode.window.showErrorMessage(fullMessage, SHOW_LOG, ...extraActions);

    if (selection === SHOW_LOG) {
        outputChannel?.show();
    } else if (selection === DELETE_LOCK && lockPath) {
        try {
            await fs.unlink(lockPath);
            outputChannel?.appendLine(`[Info] Deleted lock file at ${lockPath}`);
        } catch (e) {
            outputChannel?.appendLine(`[Error] Failed to delete lock file: ${getErrorMessage(e)}`);
            vscode.window.showErrorMessage(`Failed to delete lock file: ${getErrorMessage(e)}`);
        }
    }
    return selection;
}

/**
 * Formats a description if the 'jj-view.commit.formatDescriptionOnSave' setting is enabled.
 */
export async function maybeFormatDescriptionOnSave(
    description: string,
    scmProvider: JjScmProvider,
    revision: string = '@',
): Promise<string> {
    const config = vscode.workspace.getConfiguration('jj-view');
    const formatOnSave = config.get<boolean>('commit.formatDescriptionOnSave', false);
    if (!formatOnSave) {
        return description;
    }

    const bodyWidthRuler = config.get<number>('commit.bodyWidthRuler', 72);
    description = await formatCommitDescription(description, bodyWidthRuler);

    if (revision === '@') {
        scmProvider.sourceControl.inputBox.value = description;
    }
    return description;
}

/**
 * Helper to pick a mutable ancestor for a given revision.
 */
export async function pickAncestor(jj: JjService, revision: string): Promise<string | undefined> {
    const maxMutableAncestors = vscode.workspace.getConfiguration('jj-view').get<number>('maxMutableAncestors', 10);
    const limit = maxMutableAncestors + 1;

    const commitIds = await jj.getLogIds({ revision: `(::${revision} & mutable())`, limit });

    if (commitIds.length <= 1) {
        vscode.window.showInformationMessage('No mutable ancestors available to squash into.');
        return undefined;
    }

    const entries = await Promise.all(commitIds.map((id) => jj.getLog({ revision: id })));
    const linearAncestors = entries.map((e) => e[0]).filter(Boolean);

    const ancestorsToChoose = linearAncestors.slice(1);

    if (ancestorsToChoose.length === 0) {
        vscode.window.showInformationMessage('No mutable ancestors available to squash into.');
        return undefined;
    }

    const options: vscode.QuickPickItem[] = ancestorsToChoose.map((entry) => {
        const shortId = entry.change_id_shortest || entry.change_id.substring(0, 8);
        const desc = entry.description?.trim() || '(no description)';
        const shortDesc = desc.split('\n')[0].substring(0, 50);

        return {
            label: shortId,
            description: shortDesc,
            detail: entry.commit_id,
        };
    });

    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select which ancestor to squash into',
        matchOnDescription: true,
        matchOnDetail: true,
    });

    return selected?.detail;
}
