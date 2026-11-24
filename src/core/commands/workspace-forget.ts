/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import { formatWorkspaceLabel, type ResolvedWorkspace, resolveWorkspace } from './workspace-utils';

export interface WorkspaceForgetPayload {
    workspaceName?: string;
}

export async function workspaceForgetCommand(ctx: CommandContext, payload?: WorkspaceForgetPayload): Promise<void> {
    const { jj } = ctx.repo;
    let workspace: ResolvedWorkspace | undefined;
    try {
        workspace = await resolveWorkspace(ctx, payload?.workspaceName);
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Failed to resolve workspace', ctx.repo.jj, ctx.log);
        return;
    }
    if (!workspace) {
        return;
    }

    const workspaceLabel = formatWorkspaceLabel(workspace);
    const YES = 'Yes, Forget Workspace';
    const warningMessage = `Are you sure you want to forget ${workspaceLabel}? This will untrack it but will not delete the directory from disk.`;
    const result = ctx.host.ui.showModalWarning
        ? await ctx.host.ui.showModalWarning(warningMessage, YES)
        : await ctx.host.ui.showWarning(warningMessage, YES);

    if (result !== YES) {
        return;
    }

    try {
        await ctx.host.ui.withProgress(`Forgetting ${workspaceLabel}...`, async () => {
            await jj.workspaceForget(workspace.name);
        });

        await ctx.repo.refresh();
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, `Failed to forget ${workspaceLabel}`, ctx.repo.jj, ctx.log);
    }
}
