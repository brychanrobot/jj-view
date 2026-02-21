/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';

import { GerritService } from '../gerrit-service';
import { showJjError, withDelayedProgress } from './command-utils';

export async function uploadCommand(
    jj: JjService,
    gerrit: GerritService,
    revision: string,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const config = vscode.workspace.getConfiguration('jj-view');
    const customCommand = config.get<string>('uploadCommand');
    const hasCustomCommand = !!(customCommand && customCommand.trim().length > 0);
    try {
        let args: string[] = [];
        if (hasCustomCommand) {
            args = customCommand!.trim().split(/\s+/);
        } else {
            const isGerrit = await gerrit.isGerrit();
            if (isGerrit) {
                args = ['gerrit', 'upload'];
            } else {
                args = ['git', 'push'];
            }
        }

        if (args.length === 0) {
            vscode.window.showErrorMessage('Invalid upload command configuration.');
            return;
        }

        await withDelayedProgress(
            `Uploading revision ${revision.substring(0, 8)}...`,
            jj.upload(args, revision)
        );

        gerrit.requestRefreshWithBackoffs();
        vscode.window.setStatusBarMessage('Upload successful', 3000);
    } catch (e: unknown) {
        const CONFIGURE = 'Configure Upload...';
        const extraActions = hasCustomCommand ? [] : [CONFIGURE];
        const selection = await showJjError(e, 'Upload failed', outputChannel, extraActions);

        if (selection === CONFIGURE) {
            vscode.commands.executeCommand('workbench.action.openSettings', 'jj-view.uploadCommand');
        }
    }
}
