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

export async function compareFileWithRevisionCommand(
    jj: JjService,
    outputChannel: JjLoggerChannel,
    ...args: unknown[]
): Promise<void> {
    try {
        const fileUri = extractFileUri(args);

        if (!fileUri || fileUri.scheme !== 'file') {
            vscode.window.showErrorMessage('No workspace file selected for comparison.');
            return;
        }

        const revision = await promptForRevision(jj, {
            placeHolder: `Select an ancestor to compare ${path.basename(fileUri.fsPath)} with`,
            emptyPrompt: `Compare ${path.basename(fileUri.fsPath)} with revision`,
            revisionQuery: RevisionQuery.ancestorsExcluding('@'),
        });

        if (!revision) {
            return;
        }

        const leftUri = createRevisionUri(jj.workspaceRoot, fileUri.fsPath, revision);

        const title = `${path.basename(fileUri.fsPath)} (${revision} ↔ Working Copy)`;
        await vscode.commands.executeCommand('vscode.diff', leftUri, fileUri, title);
    } catch (err: unknown) {
        await showJjError(err, 'Failed to compare file', jj, outputChannel);
    }
}
