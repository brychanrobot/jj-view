/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import { getErrorMessage } from './command-utils';
import { resolveWorkspaceName } from './workspace-utils';

export async function workspaceDeleteCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const workspaceName = await resolveWorkspaceName(jj, args);
    if (!workspaceName) {
        return;
    }

    const YES = 'Yes, Delete Workspace';
    const result = await vscode.window.showWarningMessage(
        `Are you sure you want to forget AND delete the directory for workspace "${workspaceName}"? This action cannot be undone.`,
        { modal: true },
        YES,
    );

    if (result !== YES) {
        return;
    }

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Deleting workspace "${workspaceName}"...`,
                cancellable: false,
            },
            async () => {
                let dirPath: string | undefined;
                try {
                    dirPath = await jj.getWorkspaceRoot(workspaceName);
                } catch (e) {
                    throw new Error(`Failed to find directory for workspace "${workspaceName}"`);
                }

                await jj.workspaceForget(workspaceName);
                if (dirPath) {
                    await rmRecursive(dirPath);
                }
            },
        );
        scmProvider.refresh();
    } catch (e) {
        const message = getErrorMessage(e);
        vscode.window.showErrorMessage(`Failed to delete workspace: ${message}`);
        scmProvider.outputChannel.appendLine(`[Error] Workspace delete failed: ${message}`);
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
