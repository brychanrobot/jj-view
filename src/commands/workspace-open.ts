/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { Uri } from '../uri-utils';
import { showJjError } from './command-utils';
import { resolveWorkspaceName } from './workspace-utils';

export async function workspaceOpenInCurrentWindowCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    await openWorkspace(scmProvider, jj, args, false);
}

export async function workspaceOpenInNewWindowCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    await openWorkspace(scmProvider, jj, args, true);
}

async function openWorkspace(
    scmProvider: JjScmProvider,
    jj: JjService,
    args: unknown[],
    forceNewWindow: boolean,
): Promise<void> {
    let workspaceName: string | undefined;

    try {
        workspaceName = await resolveWorkspaceName(jj, args);
        if (!workspaceName) {
            return;
        }

        const workspacePath = await jj.getWorkspaceRoot(workspaceName);
        const uri = Uri.file(workspacePath);
        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow });
    } catch (e) {
        const prefix = workspaceName ? `Failed to open workspace "${workspaceName}"` : 'Failed to resolve workspace';
        await showJjError(e, prefix, jj, scmProvider.outputChannel);
    }
}
