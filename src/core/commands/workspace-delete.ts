/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import type { CommandContext } from '../common/command-context';
import { showJjError } from '../common/ui-helpers';
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
                await rmRecursive(dirPath);
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
 * Robustly deletes a directory. Falls back to the system `rm` command on
 * Linux/macOS when Node's fs.rm fails, which can happen because Electron
 * patches the fs module to intercept .asar paths inside VS Code installations.
 */
async function rmRecursive(dirPath: string) {
    try {
        await withTimeout(fs.promises.rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    } catch {
        if (process.platform === 'win32') {
            await execAsync('cmd.exe', ['/c', 'rd', '/s', '/q', dirPath]);
        } else {
            await execAsync('rm', ['-rf', dirPath]);
        }
    }
}

function withTimeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Timed out')), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function execAsync(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        cp.execFile(command, args, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}
