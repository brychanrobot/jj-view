/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { CodeForgeService } from '../code-forge-service';
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { extractRevision, showJjError, withDelayedProgress } from './command-utils';

export async function uploadCommand(
    scmProvider: JjScmProvider,
    jj: JjService,
    codeForge: CodeForgeService,
    args: unknown[],
    outputChannel: vscode.OutputChannel,
): Promise<void> {
    const revision = extractRevision(args);
    const config = vscode.workspace.getConfiguration('jj-view');
    const customCommand = config.get<string>('uploadCommand');
    const hasCustomCommand = !!(customCommand && customCommand.trim().length > 0);
    try {
        let subcommand = '';
        let commandArgs: string[] = [];
        let uploadRevision: string | undefined = revision;

        if (hasCustomCommand) {
            const commandStr = customCommand?.trim() || '';
            const [first, ...rest] = commandStr.split(/\s+/);
            subcommand = first;
            commandArgs = rest;
        } else {
            const activeProvider = codeForge.activeProvider;
            if (activeProvider?.getUploadCommand) {
                const rev = revision || '@';
                let hasBookmark = false;
                try {
                    const bookmarks = await jj.getBookmarks({ revision: rev });
                    hasBookmark = bookmarks.some((b) => !b.remote);
                } catch (_err) {
                    // Ignore errors (e.g. revision doesn't exist yet) and default to false
                }
                const provCommand = activeProvider.getUploadCommand(rev, hasBookmark);
                if (provCommand) {
                    subcommand = provCommand.subcommand;
                    commandArgs = provCommand.args;
                    uploadRevision = undefined; // The provider handles revision in its args, don't append -r again
                } else {
                    subcommand = 'git';
                    commandArgs = ['push'];
                }
            } else {
                subcommand = 'git';
                commandArgs = ['push'];
            }
        }

        if (!subcommand) {
            vscode.window.showErrorMessage('Invalid upload command configuration.');
            return;
        }

        const displayRev = revision || '@';
        const title = displayRev ? `Uploading revision ${displayRev.substring(0, 8)}...` : 'Uploading...';
        await withDelayedProgress(title, jj.upload(uploadRevision, subcommand, ...commandArgs));

        await scmProvider.refresh();
        codeForge.requestRefreshWithBackoffs();
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
