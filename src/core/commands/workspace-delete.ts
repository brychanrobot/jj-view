/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { isNodeErrorWithCode } from '../../utils/error-utils';
import type { CommandContext } from '../host/command-context';
import type { HostPlatform } from '../host/host-system';
import { showJjError } from '../host/ui-helpers';
import { isFilesystemRootPath, pathIsAbsolute, pathJoin, pathRelative, toFsComparisonKey } from '../path-utils';
import { getErrorMessage } from './command-utils';
import { formatWorkspaceLabel, type ResolvedWorkspace, resolveWorkspace } from './workspace-utils';

export interface WorkspaceDeletePayload {
    workspaceName?: string;
}

export async function workspaceDeleteCommand(ctx: CommandContext, payload?: WorkspaceDeletePayload): Promise<void> {
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
    const YES = 'Yes, Delete Workspace';
    const warningMessage = `Are you sure you want to forget AND delete the directory for ${workspaceLabel}? This action cannot be undone.`;
    const result = ctx.host.ui.showModalWarning
        ? await ctx.host.ui.showModalWarning(warningMessage, YES)
        : await ctx.host.ui.showWarning(warningMessage, YES);

    if (result !== YES) {
        return;
    }

    let shouldRefreshOnError = false;
    try {
        await ctx.host.ui.withProgress(`Deleting ${workspaceLabel}...`, async () => {
            if (ctx.host.system?.deleteWorkspace) {
                try {
                    await ctx.host.system.deleteWorkspace(jj.workspaceRoot, workspace.name);
                } catch (err: unknown) {
                    if (getErrorMessage(err).includes('Workspace was forgotten')) {
                        shouldRefreshOnError = true;
                    }
                    throw err;
                }
                await jj.clearCache().catch(() => {});
                return;
            }

            let dirPath: string;
            try {
                dirPath = await jj.getWorkspaceRoot(workspace.name);
            } catch (err: unknown) {
                const detail = getErrorMessage(err);
                throw new Error(`Could not find workspace directory (${detail})`);
            }
            if (!dirPath) {
                throw new Error('Could not find workspace directory');
            }

            const { dirExists } = await assertSafeWorkspaceDirectory(ctx, dirPath);
            await jj.workspaceForget(workspace.name);
            shouldRefreshOnError = true;
            if (dirExists) {
                await rmRecursive(ctx, dirPath);
            }
        });

        await ctx.repo.refresh();
    } catch (e: unknown) {
        if (shouldRefreshOnError) {
            await jj.clearCache().catch(() => {});
            await ctx.repo.refresh().catch(() => {});
        }
        await showJjError(ctx.host.ui, e, `Failed to delete ${workspaceLabel}`, ctx.repo.jj, ctx.log);
    }
}

function isSameOrAncestor(ancestor: string, target: string, platform?: HostPlatform | string): boolean {
    const rel = pathRelative(toFsComparisonKey(ancestor, platform), toFsComparisonKey(target, platform), platform);
    return (
        rel === '' ||
        rel === '.' ||
        (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !pathIsAbsolute(rel, platform))
    );
}

async function assertSafeWorkspaceDirectory(ctx: CommandContext, dirPath: string): Promise<{ dirExists: boolean }> {
    const platform = ctx.host.system?.platform;
    const hostFs = ctx.host.system?.fs;
    const activeRoot = ctx.repo.jj.workspaceRoot;

    const dirCanonical = hostFs ? await hostFs.realpath(dirPath).catch(() => dirPath) : dirPath;
    const activeCanonical = hostFs ? await hostFs.realpath(activeRoot).catch(() => activeRoot) : activeRoot;

    if (isFilesystemRootPath(dirPath, platform) || isFilesystemRootPath(dirCanonical, platform)) {
        throw new Error('Cannot remove filesystem root');
    }

    if (
        isSameOrAncestor(dirPath, activeRoot, platform) ||
        isSameOrAncestor(dirCanonical, activeCanonical, platform) ||
        isSameOrAncestor(dirPath, activeCanonical, platform) ||
        isSameOrAncestor(dirCanonical, activeRoot, platform)
    ) {
        throw new Error('Cannot delete the active workspace directory or a parent containing it');
    }

    if (!hostFs) {
        return { dirExists: true };
    }

    try {
        const stat = await hostFs.lstat(dirPath);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error('Refusing to delete non-directory workspace path');
        }
    } catch (err: unknown) {
        if (isNodeErrorWithCode(err, 'ENOENT')) {
            return { dirExists: false };
        }
        throw err;
    }

    try {
        const mainRepoStat = await hostFs.lstat(pathJoin([dirPath, '.jj', 'repo'], platform));
        if (mainRepoStat.isDirectory()) {
            throw new Error('Cannot delete the main repository workspace directory containing .jj/repo');
        }
    } catch (err: unknown) {
        if (!isNodeErrorWithCode(err, 'ENOENT')) {
            throw err;
        }
    }

    try {
        const jjStat = await hostFs.lstat(pathJoin([dirPath, '.jj'], platform));
        if (!jjStat.isDirectory()) {
            throw new Error('Refusing to delete directory without .jj metadata');
        }
    } catch (err: unknown) {
        if (isNodeErrorWithCode(err, 'ENOENT')) {
            throw new Error('Refusing to delete directory without .jj metadata');
        }
        throw err;
    }

    return { dirExists: true };
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
