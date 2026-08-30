/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import { maybeFormatDescriptionOnSave } from './command-utils';

export interface CommitPayload {
    description?: string;
}

export async function commitCommand(ctx: CommandContext, payload?: CommitPayload): Promise<void> {
    let description = payload?.description?.trim() ?? '';
    if (description) {
        description = await maybeFormatDescriptionOnSave(description, ctx);
    }
    try {
        await ctx.host.ui.withProgress('Committing...', () => ctx.repo.jj.commit(description));
        await ctx.repo.refresh({ reason: 'after commit' });
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Error committing change', ctx.repo.jj, ctx.log);
    }
}
