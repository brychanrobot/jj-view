/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import { getErrorMessage } from './command-utils';
import { resolveWorkspaceName } from './workspace-utils';

export interface WorkspaceForgetPayload {
    workspaceName?: string;
}

export async function workspaceForgetCommand(ctx: CommandContext, payload?: WorkspaceForgetPayload): Promise<void> {
    const { jj } = ctx.repo;
    const workspaceName = await resolveWorkspaceName(ctx, payload?.workspaceName);
    if (!workspaceName) {
        return;
    }

    const YES = 'Yes, Forget Workspace';
    const warningMessage = `Are you sure you want to forget the workspace "${workspaceName}"? This will untrack it but will not delete the directory from disk.`;
    const result = ctx.host.ui.showModalWarning
        ? await ctx.host.ui.showModalWarning(warningMessage, YES)
        : await ctx.host.ui.showWarning(warningMessage, YES);

    if (result !== YES) {
        return;
    }

    try {
        await ctx.host.ui.withProgress(`Forgetting workspace "${workspaceName}"...`, async () => {
            await jj.workspaceForget(workspaceName);
        });

        await ctx.repo.refresh();
    } catch (e: unknown) {
        const message = getErrorMessage(e);
        await showJjError(
            ctx.host.ui,
            new Error(`Failed to forget workspace: ${message}`),
            'Workspace Forget Error',
            ctx.repo.jj,
            ctx.log,
        );
    }
}
