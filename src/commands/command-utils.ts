/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JjResourceState } from '../jj-scm-provider';
import * as vscode from 'vscode';

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
    return isSourceControlResourceGroup(arg) && arg.id === 'working-copy';
}

export function isParentResourceGroup(arg: unknown): arg is vscode.SourceControlResourceGroup {
    return isSourceControlResourceGroup(arg) && arg.id.startsWith('parent-');
}

/**
 * Helper to check if a specific revision was passed as a string argument
 * (often from the command palette or explicit tool calls)
 */
export function extractRevision(args: unknown[]): string | undefined {
    for (const arg of args) {
        if (typeof arg === 'string' && arg.trim().length > 0) {
            return arg;
        }

        if (hasRevision(arg)) {
            return arg.revision;
        }

        if (hasCommitId(arg)) {
            return arg.commitId;
        }

        if (isWorkingCopyResourceGroup(arg)) {
            return '@';
        }

        if (isParentResourceGroup(arg) && arg.resourceStates.length > 0) {
            const firstState = arg.resourceStates[0] as JjResourceState;
            return firstState.revision;
        }
    }
    // 5. Webview Context (generic object with commitId)
    const arg0 = args[0];
    if (hasCommitId(arg0)) {
        return arg0.commitId;
    }

    return undefined;
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
            }
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
