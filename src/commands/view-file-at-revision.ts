/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { JjService } from '../jj-service';
import { createRevisionUri } from '../uri-utils';
import type { JjLoggerChannel } from '../utils/output-channel';
import { extractFileUri, promptForRevision, RevisionQuery, showJjError } from './command-utils';

export async function viewFileAtRevisionCommand(
    jj: JjService,
    outputChannel: JjLoggerChannel,
    ...args: unknown[]
): Promise<void> {
    try {
        const fileUri = extractFileUri(args) ?? vscode.window.activeTextEditor?.document.uri;

        if (!fileUri || fileUri.scheme !== 'file') {
            vscode.window.showErrorMessage('No workspace file selected.');
            return;
        }

        const revision = await promptForRevision(jj, {
            placeHolder: `Select a revision to view ${path.basename(fileUri.fsPath)} at`,
            emptyPrompt: `View ${path.basename(fileUri.fsPath)} at revision`,
            revisionQuery: RevisionQuery.visible(),
        });

        if (!revision) {
            return;
        }

        const revisionUri = createRevisionUri(jj.workspaceRoot, fileUri.fsPath, revision);

        await vscode.commands.executeCommand('vscode.open', revisionUri);
    } catch (err: unknown) {
        await showJjError(err, 'Failed to view file at revision', jj, outputChannel);
    }
}
