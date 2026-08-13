/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../common/command-context';

export interface CommitMenuContext {
    commitId: string;
}

export interface RebaseOntoSelectedPayload {
    sourceId?: string;
    destinations?: string[];
}

export async function rebaseOntoSelectedCommand(
    ctx: CommandContext,
    payload?: RebaseOntoSelectedPayload,
): Promise<void> {
    const sourceId = payload?.sourceId;
    if (!sourceId) {
        return;
    }

    const destinations = payload?.destinations ?? [];
    if (destinations.length === 0) {
        await ctx.ui.showError(new Error('No commits selected to rebase onto.'), 'Rebase Error');
        return;
    }

    try {
        await ctx.ui.withProgress(`Rebasing ${sourceId.substring(0, 8)} onto ${destinations.length} dest(s)...`, () =>
            ctx.repo.jj.rebase(sourceId, destinations, 'source'),
        );
        await ctx.repo.refresh();
    } catch (err: unknown) {
        await ctx.ui.showError(err, 'Error rebasing');
    }
}
