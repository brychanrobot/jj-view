/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import { JjService } from '../jj-service';

/**
 * Resolves a workspace name from command arguments or by prompting the user with a QuickPick.
 *
 * @param jj The Jujutsu service instance.
 * @param args The command arguments (expected to contain { workspaceName: string } if from a context menu).
 * @returns The resolved workspace name, or undefined if the user cancelled or no workspaces were found.
 */
export async function resolveWorkspaceName(jj: JjService, args: unknown[]): Promise<string | undefined> {
    // 1. Try to extract from args (context menu case)
    const arg = args[0];
    if (arg && typeof arg === 'object' && 'workspaceName' in arg && typeof arg.workspaceName === 'string') {
        return arg.workspaceName;
    }

    // 2. Prompt with QuickPick (command palette case)
    const workspaces = await jj.getWorkspaces();

    if (workspaces.length === 0) {
        vscode.window.showErrorMessage('No workspaces found in this repository.');
        return undefined;
    }

    if (workspaces.length === 1) {
        return workspaces[0];
    }

    const selection = await vscode.window.showQuickPick(workspaces, {
        placeHolder: 'Select a workspace to operate on',
        title: 'Workspace Action',
    });

    return selection;
}
