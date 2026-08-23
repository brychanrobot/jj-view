/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import type { JjWorkspace } from '../jj-types';

/**
 * Resolves a workspace name from a provided name or by prompting the user with a QuickPick.
 *
 * @param ctx The command context.
 * @param providedWorkspaceName Optional workspace name provided directly via payload.
 * @returns The resolved workspace name, or undefined if the user cancelled or no workspaces were found.
 */
export async function resolveWorkspaceName(
    ctx: CommandContext,
    providedWorkspaceName?: string,
): Promise<string | undefined> {
    const { jj } = ctx.repo;
    const { ui } = ctx.host;

    const trimmed = providedWorkspaceName?.trim();
    if (trimmed) {
        return trimmed;
    }

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
    });

    return selection?.label;
}
