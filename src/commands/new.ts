/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';

export interface NewPayload {
    parents?: string[];
}

export async function newCommand(ctx: CommandContext, payload?: NewPayload): Promise<void> {
    const parents = payload?.parents;
    try {
        await ctx.ui.withProgress('Creating new change...', () => ctx.repo.jj.new({ parents }));
        await ctx.repo.refresh({ reason: 'after new' });
    } catch (e: unknown) {
        await ctx.ui.showError(e, 'Error creating new commit');
    }
}
