/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import { RevisionQuery } from './command-utils';

export interface AbandonPayload {
    revisions?: string[];
}

export async function abandonCommand(ctx: CommandContext, payload?: AbandonPayload): Promise<void> {
    let revisions = payload?.revisions ?? [];

    if (revisions.length === 0) {
        const input = await ctx.ui.promptForRevision({
            placeHolder: 'Select revision to abandon',
            revisionQuery: RevisionQuery.mutable(),
        });
        if (input) {
            revisions = [input];
        }
    }

    if (revisions.length === 0) {
        return;
    }

    try {
        await ctx.ui.withProgress('Abandoning...', () => ctx.repo.jj.abandon(revisions));
        await ctx.repo.refresh({ reason: 'abandon' });
        await ctx.ui.showInformation(`Abandoned ${revisions.length} change(s).`);
    } catch (e: unknown) {
        await ctx.ui.showError(e, 'Failed to abandon');
    }
}
