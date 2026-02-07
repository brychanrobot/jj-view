/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { extractRevision, getErrorMessage } from './command-utils';
import { JjLogWebviewProvider } from '../jj-log-webview-provider';

export async function showDetailsCommand(logWebviewProvider: JjLogWebviewProvider, args: unknown[]) {
    const revision = extractRevision(args);
    if (!revision) {
        return;
    }

    try {
        await logWebviewProvider.createCommitDetailsPanel(revision);
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Error showing details: ${getErrorMessage(e)}`);
    }
}
