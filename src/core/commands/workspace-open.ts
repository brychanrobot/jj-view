/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../common/command-context';
import { showJjError } from '../common/ui-helpers';
import { Uri } from '../uri-utils';
import { resolveWorkspaceName } from './workspace-utils';

export interface WorkspaceOpenInCurrentWindowPayload {
    workspaceName?: string;
}

export interface WorkspaceOpenInNewWindowPayload {
    workspaceName?: string;
}

export async function workspaceOpenInCurrentWindowCommand(
    ctx: CommandContext,
    payload?: WorkspaceOpenInCurrentWindowPayload,
): Promise<void> {
    await openWorkspace(ctx, payload?.workspaceName, false);
}

export async function workspaceOpenInNewWindowCommand(
    ctx: CommandContext,
    payload?: WorkspaceOpenInNewWindowPayload,
): Promise<void> {
    await openWorkspace(ctx, payload?.workspaceName, true);
}

async function openWorkspace(
    ctx: CommandContext,
    providedWorkspaceName: string | undefined,
    forceNewWindow: boolean,
): Promise<void> {
    let workspaceName: string | undefined;
    const { jj } = ctx.repo;

    try {
        workspaceName = await resolveWorkspaceName(ctx, providedWorkspaceName);
        if (!workspaceName) {
            return;
        }

        const workspacePath = await jj.getWorkspaceRoot(workspaceName);
        const uri = Uri.file(workspacePath);
        await ctx.host.nav.openFolder(uri, forceNewWindow);
    } catch (e: unknown) {
        const prefix = workspaceName ? `Failed to open workspace "${workspaceName}"` : 'Failed to resolve workspace';
        await showJjError(ctx.host.ui, e, prefix, ctx.repo.jj, ctx.log);
    }
}
