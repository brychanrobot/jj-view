/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../common/command-context';

export interface NewAfterPayload {
    revisions: string[];
}

export async function newAfterCommand(ctx: CommandContext, payload?: NewAfterPayload): Promise<void> {
    const revisions = payload?.revisions ?? ['@'];

    if (revisions.length === 0) {
        await ctx.host.ui.showError(new Error('No commit selected to create a new change after.'), 'New After Error');
        return;
    }

    try {
        await ctx.host.ui.withProgress('Creating new change...', () => ctx.repo.jj.new({ insertAfter: revisions }));
        await ctx.repo.refresh();
    } catch (e: unknown) {
        await ctx.host.ui.showError(e, `Error creating new commit after ${revisions.join(', ')}`);
    }
}
