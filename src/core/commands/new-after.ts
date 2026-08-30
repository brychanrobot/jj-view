/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export interface NewAfterPayload {
    revisions: string[];
}

export async function newAfterCommand(ctx: CommandContext, payload?: NewAfterPayload): Promise<void> {
    const revisions = payload?.revisions ?? ['@'];

    if (revisions.length === 0) {
        await showJjError(
            ctx.host.ui,
            new Error('No commit selected to create a new change after.'),
            'New After Error',
            ctx.repo.jj,
            ctx.log,
        );
        return;
    }

    try {
        await ctx.host.ui.withProgress('Creating new change...', () => ctx.repo.jj.new({ insertAfter: revisions }));
        await ctx.repo.refresh();
    } catch (e: unknown) {
        await showJjError(
            ctx.host.ui,
            e,
            `Error creating new commit after ${revisions.join(', ')}`,
            ctx.repo.jj,
            ctx.log,
        );
    }
}
