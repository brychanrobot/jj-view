/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import { GerritService } from '../gerrit-service';
import { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import { extractRevision, showJjError, withDelayedProgress } from './command-utils';

export async function uploadCommand(
    scmProvider: JjScmProvider,
    jj: JjService,
    gerrit: GerritService,
    args: unknown[],
    outputChannel: vscode.OutputChannel,
): Promise<void> {
    const revision = extractRevision(args);
    const config = vscode.workspace.getConfiguration('jj-view');
    const customCommand = config.get<string>('uploadCommand');
    const hasCustomCommand = !!(customCommand && customCommand.trim().length > 0);
    try {
        let commandStr = '';
        if (hasCustomCommand) {
            commandStr = customCommand!.trim();
        } else {
            const isGerrit = await gerrit.isGerrit();
            commandStr = isGerrit ? 'gerrit upload' : 'git push';
        }

        if (commandStr.length === 0) {
            vscode.window.showErrorMessage('Invalid upload command configuration.');
            return;
        }

        const [subcommand, ...commandArgs] = commandStr.split(/\s+/);
        const title = revision ? `Uploading revision ${revision.substring(0, 8)}...` : 'Uploading...';
        await withDelayedProgress(title, jj.upload(revision, subcommand, ...commandArgs));

        await scmProvider.refresh();
        gerrit.requestRefreshWithBackoffs();
        vscode.window.setStatusBarMessage('Upload successful', 3000);
    } catch (e: unknown) {
        const CONFIGURE = 'Configure Upload...';
        const extraActions = hasCustomCommand ? [] : [CONFIGURE];
        const selection = await showJjError(e, 'Upload failed', jj, outputChannel, extraActions);

        if (selection === CONFIGURE) {
            vscode.commands.executeCommand('workbench.action.openSettings', 'jj-view.uploadCommand');
        }
    }
}
