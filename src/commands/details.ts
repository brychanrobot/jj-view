/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import { showJjError } from '../common/ui-helpers';

export interface ShowDetailsPayload {
    revision?: string;
}

export async function showDetailsCommand(ctx: CommandContext, payload?: ShowDetailsPayload): Promise<void> {
    const {
        repo,
        host: { ui, nav },
    } = ctx;
    const { jj } = repo;
    const revision = payload?.revision || '@';

    try {
        const [logEntry] = await ui.withProgress('Loading details...', () => jj.getLog({ revision }));
        if (!logEntry) {
            throw new Error(`No log entry found for revision: ${revision}`);
        }
        await nav.openCommitDetails(
            jj.workspaceRoot,
            logEntry.change_id,
            logEntry.change_id_shortest,
            logEntry.is_divergent,
            logEntry.change_id_offset,
        );
    } catch (e: unknown) {
        await showJjError(ui, e, 'Error showing details', jj, ctx.log);
    }
}
