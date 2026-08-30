/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import { RevisionQuery } from './command-utils';

export interface AbandonPayload {
    revisions?: string[];
}

export async function abandonCommand(ctx: CommandContext, payload?: AbandonPayload): Promise<void> {
    let revisions = payload?.revisions ?? [];

    if (revisions.length === 0) {
        const input = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
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
        await ctx.host.ui.withProgress('Abandoning...', () => ctx.repo.jj.abandon(revisions));
        await ctx.repo.refresh({ reason: 'abandon' });
        await ctx.host.ui.showInformation(`Abandoned ${revisions.length} change(s).`);
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Failed to abandon', ctx.repo.jj, ctx.log);
    }
}
