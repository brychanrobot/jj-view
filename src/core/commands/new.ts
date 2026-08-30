/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export interface NewPayload {
    parents?: string[];
}

export async function newCommand(ctx: CommandContext, payload?: NewPayload): Promise<void> {
    const parents = payload?.parents;
    try {
        await ctx.host.ui.withProgress('Creating new change...', () => ctx.repo.jj.new({ parents }));
        await ctx.repo.refresh({ reason: 'after new' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error creating new commit', ctx.repo.jj, ctx.log);
    }
}
