/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JjResourceState } from '../jj-scm-provider';
import { ScmContextValue } from '../jj-context-keys';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { JjService } from '../jj-service';

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

function hasRevision(arg: unknown): arg is { revision: string } {
    if (typeof arg !== 'object' || arg === null || !('revision' in arg)) {
        return false;
    }
    const obj = arg as { revision: unknown };
    return typeof obj.revision === 'string';
}

function hasCommitId(arg: unknown): arg is { commitId: string } {
    if (typeof arg !== 'object' || arg === null || !('commitId' in arg)) {
        return false;
    }
    const obj = arg as { commitId: unknown };
    return typeof obj.commitId === 'string';
}

function hasChangeId(arg: unknown): arg is { changeId: string } {
    if (typeof arg !== 'object' || arg === null || !('changeId' in arg)) {
        return false;
    }
    const obj = arg as { changeId: unknown };
    return typeof obj.changeId === 'string';
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

    return Array.from(unique.values());
}

function isSourceControlResourceGroup(arg: unknown): arg is vscode.SourceControlResourceGroup {
    return typeof arg === 'object' && arg !== null && 'id' in arg && 'label' in arg && 'resourceStates' in arg;
}

export function isWorkingCopyResourceGroup(arg: unknown): arg is vscode.SourceControlResourceGroup {
    return isSourceControlResourceGroup(arg) && arg.id === ScmContextValue.WorkingCopyGroup;
}

export function isParentResourceGroup(arg: unknown): arg is vscode.SourceControlResourceGroup {
    return isSourceControlResourceGroup(arg) && arg.id.startsWith('ancestor-');
}

/**
 * Helper to extract revisions from various VS Code argument types.
 * Supports strings, objects with revision/commitId, and resource groups.
 */
export function extractRevisions(args: unknown[]): string[] {
    const revisions: string[] = [];

    for (const arg of args) {
        if (!arg) continue;

        if (typeof arg === 'string' && arg.trim().length > 0) {
            revisions.push(arg);
            continue;
        }

        if (hasRevision(arg)) {
            revisions.push(arg.revision);
            continue;
        }

        if (hasChangeId(arg)) {
            revisions.push(arg.changeId);
            continue;
        }

        if (hasCommitId(arg)) {
            revisions.push(arg.commitId);
            continue;
        }

        if (isWorkingCopyResourceGroup(arg)) {
            revisions.push('@');
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

    return Array.from(new Set(revisions));
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
 * Wraps a promise with a delayed progress notification.
 * If the promise resolves within 100ms, no notification is shown.
 * If it takes longer, a progress notification appears until the promise resolves.
 */
export async function withDelayedProgress<T>(title: string, promise: Promise<T>): Promise<T> {
    const DELAY_MS = 100;

    let notificationResolver: (value?: unknown) => void;
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
        if (notificationResolver!) {
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
        } catch (e) {
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
