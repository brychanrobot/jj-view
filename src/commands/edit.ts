/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';

export interface EditPayload {
    revision?: string;
}

export async function editCommand(ctx: CommandContext, payload?: EditPayload): Promise<void> {
    const revision = payload?.revision;
    if (!revision) {
        return;
    }

    try {
        await ctx.ui.withProgress('Editing...', () => ctx.repo.jj.edit(revision));
        await ctx.repo.refresh({ reason: 'after edit' });
    } catch (e: unknown) {
        await ctx.ui.showError(e, 'Error editing commit');
    }
}
