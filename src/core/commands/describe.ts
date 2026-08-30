/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import { maybeFormatDescriptionOnSave } from './command-utils';

export interface SetDescriptionPayload {
    description?: string;
    revision?: string;
}

export async function setDescriptionCommand(
    ctx: CommandContext,
    payload?: SetDescriptionPayload,
): Promise<string | false> {
    const revision = payload?.revision ?? '@';
    let description = (payload?.description ?? '').trim();
    description = await maybeFormatDescriptionOnSave(description, ctx);

    try {
        await ctx.host.ui.withProgress('Setting description...', () => ctx.repo.jj.describe(description, revision));
        await ctx.repo.refresh({ reason: 'after describe' });
        return description;
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error setting description', ctx.repo.jj, ctx.log);
        return false;
    }
}
