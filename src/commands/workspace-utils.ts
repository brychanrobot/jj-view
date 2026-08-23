/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import type { JjWorkspace } from '../jj-types';

/**
 * Resolves a workspace name from command arguments or by prompting the user with a QuickPick.
 *
 * @param ctx The command context.
 * @param args The command arguments (expected to contain { workspaceName: string } if from a context menu).
 * @returns The resolved workspace name, or undefined if the user cancelled or no workspaces were found.
 */
export async function resolveWorkspaceName(ctx: CommandContext, args?: unknown[]): Promise<string | undefined> {
    const { jj } = ctx.repo;
    const { ui } = ctx.host;

    // 1. Try to extract from args (context menu case)
    const arg = args?.[0];
    if (arg && typeof arg === 'object' && 'workspaceName' in arg && typeof arg.workspaceName === 'string') {
        return arg.workspaceName;
    }

    // 2. Prompt with QuickPick (command palette case)
    const workspaces: JjWorkspace[] = await jj.getWorkspaces();

    if (workspaces.length === 0) {
        await ui.showError(new Error('No workspaces found in this repository.'), 'Workspace Error');
        return undefined;
    }

    if (workspaces.length === 1) {
        return workspaces[0].name;
    }

    const items = workspaces.map((w) => ({
        label: w.name,
        description: w.path,
    }));

    const selection = await ui.showQuickPick(items, {
        placeHolder: 'Select a workspace to operate on',
        title: 'Workspace Action',
    });

    return selection?.label;
}
