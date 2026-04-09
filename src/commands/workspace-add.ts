/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import { getErrorMessage } from './command-utils';

/**
 * Command to create a new jj workspace.
 */
export async function workspaceAddCommand(scmProvider: JjScmProvider, jj: JjService) {
    try {
        // 1. Find main workspace root
        const mainRoot = await jj.getMainWorkspaceRoot();

        // 2. Get workspaces location from config
        const config = vscode.workspace.getConfiguration('jj-view');
        let workspacesLocation = config.get<string>('workspacesLocation', '.workspaces');

        // Resolve relative paths against the main repo root
        if (!path.isAbsolute(workspacesLocation)) {
            workspacesLocation = path.resolve(mainRoot, workspacesLocation);
        }

        // 3. Prompt for workspace name
        const workspaceName = await vscode.window.showInputBox({
            prompt: 'Enter a name for the new workspace',
            placeHolder: 'e.g. my-feature',
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Workspace name is required';
                }
                if (/[<>:"/\\|?*]/.test(value)) {
                    return 'Workspace name contains invalid characters';
                }
                return null;
            },
        });

        if (!workspaceName) {
            return;
        }

        const destination = path.join(workspacesLocation, workspaceName);

        // 4. Run jj workspace add
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Creating workspace "${workspaceName}"...`,
                cancellable: false,
            },
            async () => {
                // Ensure the parent directory (workspacesLocation) exists
                await fs.promises.mkdir(workspacesLocation, { recursive: true });
                await jj.workspaceAdd(destination, workspaceName);
            },
        );

        // 5. Success notification with "Open" action
        const OPEN = 'Open Workspace';
        const result = await vscode.window.showInformationMessage(
            `Workspace "${workspaceName}" created successfully.`,
            OPEN,
        );

        if (result === OPEN) {
            const uri = vscode.Uri.file(destination);
            await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
        }

        await scmProvider.refresh();
    } catch (e) {
        const message = getErrorMessage(e);
        vscode.window.showErrorMessage(`Failed to create workspace: ${message}`);
        scmProvider.outputChannel.appendLine(`[Error] Workspace creation failed: ${message}`);
    }
}
