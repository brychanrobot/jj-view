/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as vscode from 'vscode';
import { openCommitDetails } from '../jj-commit-details-editor-provider';
import type { JjService } from '../jj-service';
import { extractRevision, showJjError, withDelayedProgress } from './command-utils';

export async function showDetailsCommand(jj: JjService, outputChannel: vscode.OutputChannel, args: unknown[]) {
    const revision = extractRevision(args) || '@';

    try {
        const [logEntry] = await withDelayedProgress('Loading details...', jj.getLog({ revision }));
        if (!logEntry) {
            throw new Error(`No log entry found for revision: ${revision}`);
        }
        await openCommitDetails(
            jj.workspaceRoot,
            logEntry.change_id,
            logEntry.change_id_shortest,
            logEntry.is_divergent,
            logEntry.change_id_offset,
        );
    } catch (e: unknown) {
        await showJjError(e, 'Error showing details', jj, outputChannel);
    }
}
