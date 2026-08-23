/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import { getErrorMessage } from './command-utils';
import { resolveWorkspaceName } from './workspace-utils';

export interface WorkspaceForgetPayload {
    workspaceName?: string;
}

export async function workspaceForgetCommand(ctx: CommandContext, payload?: WorkspaceForgetPayload): Promise<void> {
    const { jj } = ctx.repo;
    const workspaceName = payload?.workspaceName ?? (await resolveWorkspaceName(ctx, []));
    if (!workspaceName) {
        return;
    }

    const YES = 'Yes, Forget Workspace';
    const result = await ctx.host.ui.showWarning(
        `Are you sure you want to forget the workspace "${workspaceName}"? This will untrack it but will not delete the directory from disk.`,
        { modal: true },
        YES,
    );

    if (result !== YES) {
        return;
    }

    try {
        await ctx.host.ui.withProgress(`Forgetting workspace "${workspaceName}"...`, async () => {
            await jj.workspaceForget(workspaceName);
        });

        await ctx.repo.refresh();
    } catch (e) {
        const message = getErrorMessage(e);
        await ctx.host.ui.showError(new Error(`Failed to forget workspace: ${message}`), 'Workspace Forget Error');
    }
}
