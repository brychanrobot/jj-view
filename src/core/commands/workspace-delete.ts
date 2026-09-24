/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import { getErrorMessage } from './command-utils';
import { resolveWorkspaceName } from './workspace-utils';

export interface WorkspaceDeletePayload {
    workspaceName?: string;
}

export async function workspaceDeleteCommand(ctx: CommandContext, payload?: WorkspaceDeletePayload): Promise<void> {
    const { jj } = ctx.repo;
    const workspaceName = await resolveWorkspaceName(ctx, payload?.workspaceName);
    if (!workspaceName) {
        return;
    }

    const YES = 'Yes, Delete Workspace';
    const warningMessage = `Are you sure you want to forget AND delete the directory for workspace "${workspaceName}"? This action cannot be undone.`;
    const result = ctx.host.ui.showModalWarning
        ? await ctx.host.ui.showModalWarning(warningMessage, YES)
        : await ctx.host.ui.showWarning(warningMessage, YES);

    if (result !== YES) {
        return;
    }

    try {
        await ctx.host.ui.withProgress(`Deleting workspace "${workspaceName}"...`, async () => {
            let dirPath: string | undefined;
            try {
                dirPath = await jj.getWorkspaceRoot(workspaceName);
            } catch (_) {
                throw new Error(`Failed to find directory for workspace "${workspaceName}"`);
            }

            await jj.workspaceForget(workspaceName);
            if (dirPath) {
                await rmRecursive(ctx, dirPath);
            }
        });

        await ctx.repo.refresh();
    } catch (e: unknown) {
        const message = getErrorMessage(e);
        await showJjError(
            ctx.host.ui,
            new Error(`Failed to delete workspace: ${message}`),
            'Workspace Delete Error',
            ctx.repo.jj,
            ctx.log,
        );
    }
}

/**
 * Robustly deletes a directory using HostSystem fs and process fallback.
 */
async function rmRecursive(ctx: CommandContext, dirPath: string): Promise<void> {
    const hostFs = ctx.host.system?.fs;
    let fsError: unknown;
    if (hostFs) {
        try {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const rmPromise = hostFs.rm(dirPath, { recursive: true, force: true });
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('Directory removal timed out after 5000ms')), 5000);
            });
            await Promise.race([rmPromise, timeoutPromise]).finally(() => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            });
            return;
        } catch (err) {
            fsError = err;
        }
    }
    const hostProcess = ctx.host.system?.process;
    if (hostProcess) {
        const isWin = ctx.host.system?.platform === 'win32';
        if (isWin) {
            await hostProcess.execFile('cmd.exe', ['/c', 'rd', '/s', '/q', dirPath]);
        } else {
            await hostProcess.execFile('rm', ['-rf', dirPath]);
        }
        return;
    }
    if (fsError) {
        throw fsError;
    }
    throw new Error('Host system does not support filesystem or process execution');
}
