/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { JjService } from '../jj-service';
import { encodeJjViewQuery } from '../uri-utils';
import { promptForRevision, showJjError } from './command-utils';

export async function compareFileWithRevisionCommand(
    jj: JjService,
    outputChannel: vscode.OutputChannel,
    ...args: unknown[]
): Promise<void> {
    try {
        let fileUri: vscode.Uri | undefined;

        const firstArg = args[0];
        if (firstArg instanceof vscode.Uri) {
            fileUri = firstArg;
        } else if (typeof firstArg === 'object' && firstArg !== null && 'resourceUri' in firstArg) {
            const state = firstArg as { resourceUri: unknown };
            if (state.resourceUri instanceof vscode.Uri) {
                fileUri = state.resourceUri;
            }
        } else {
            fileUri = vscode.window.activeTextEditor?.document.uri;
        }

        if (!fileUri || fileUri.scheme !== 'file') {
            vscode.window.showErrorMessage('No workspace file selected for comparison.');
            return;
        }

        const revision = await promptForRevision(
            jj,
            '@',
            `Select an ancestor to compare ${path.basename(fileUri.fsPath)} with`,
            `Compare ${path.basename(fileUri.fsPath)} with revision`,
        );

        if (!revision) {
            return;
        }

        const leftUri = fileUri.with({
            scheme: 'jj-view',
            query: encodeJjViewQuery({ mode: 'revision', revision }),
        });

        const title = `${path.basename(fileUri.fsPath)} (${revision} ↔ Working Copy)`;
        await vscode.commands.executeCommand('vscode.diff', leftUri, fileUri, title);
    } catch (err: unknown) {
        await showJjError(err, 'Failed to compare file', jj, outputChannel);
    }
}
