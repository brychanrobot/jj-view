/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


import { extractRevision, showJjError } from './command-utils';
import { JjLogWebviewProvider } from '../jj-log-webview-provider';

export async function showDetailsCommand(
    logWebviewProvider: JjLogWebviewProvider, 
    args: unknown[]
) {
    const revision = extractRevision(args);
    if (!revision) {
        return;
    }

    try {
        await logWebviewProvider.createCommitDetailsPanel(revision);
    } catch (e: unknown) {
        showJjError(e, 'Error showing details', logWebviewProvider.outputChannel);
    }
}
