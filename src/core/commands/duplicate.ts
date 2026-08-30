/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import { showJjError } from '../common/ui-helpers';

export interface DuplicatePayload {
    revision?: string;
}

export async function duplicateCommand(ctx: CommandContext, payload?: DuplicatePayload): Promise<void> {
    const revision = payload?.revision;
    if (!revision) {
        return;
    }

    try {
        await ctx.host.ui.withProgress('Duplicating...', () => ctx.repo.jj.duplicate(revision));
        await ctx.repo.refresh({ reason: 'after duplicate' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error duplicating commit', ctx.repo.jj, ctx.log);
    }
}
