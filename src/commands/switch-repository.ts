/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import {
    findJjWorkspaceRoots,
    persistJjWorkspaceRoot,
    pickJjWorkspaceRoot,
    type JjWorkspaceDiscoveryContext,
} from '../utils/workspace-discovery';

export async function switchRepositoryCommand(
    context: JjWorkspaceDiscoveryContext,
    currentRoot: string,
    outputChannel: vscode.OutputChannel,
): Promise<void> {
    const vscodeWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!vscodeWorkspaceRoot) {
        return;
    }

    const candidates = await findJjWorkspaceRoots(vscodeWorkspaceRoot);
    if (candidates.length <= 1) {
        await vscode.window.showInformationMessage('Only one Jujutsu repository found in this workspace.');
        return;
    }

    const picked = await pickJjWorkspaceRoot(vscodeWorkspaceRoot, { currentRoot, candidates });
    if (!picked || picked === currentRoot) {
        return;
    }

    await persistJjWorkspaceRoot(context, picked);
    outputChannel.appendLine(`[Extension] Switching Jujutsu repository to: ${picked}`);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
}
