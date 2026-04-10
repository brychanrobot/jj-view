/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import { getErrorMessage } from './command-utils';
import { resolveWorkspaceName } from './workspace-utils';

export async function workspaceForgetCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const workspaceName = await resolveWorkspaceName(jj, args);
    if (!workspaceName) {
        return;
    }

    const YES = 'Yes, Forget Workspace';
    const result = await vscode.window.showWarningMessage(
        `Are you sure you want to forget the workspace "${workspaceName}"? This will untrack it but will not delete the directory from disk.`,
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
                title: `Forgetting workspace "${workspaceName}"...`,
                cancellable: false,
            },
            async () => {
                await jj.workspaceForget(workspaceName);
            },
        );
        scmProvider.refresh();
    } catch (e) {
        const message = getErrorMessage(e);
        vscode.window.showErrorMessage(`Failed to forget workspace: ${message}`);
        scmProvider.outputChannel.appendLine(`[Error] Workspace forget failed: ${message}`);
    }
}
