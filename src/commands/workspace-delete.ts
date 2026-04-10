/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
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
                    await fs.promises.rm(dirPath, { recursive: true, force: true });
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
