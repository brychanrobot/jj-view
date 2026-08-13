/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
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
    description = await maybeFormatDescriptionOnSave(description, ctx, revision);

    try {
        await ctx.ui.withProgress('Setting description...', () => ctx.repo.jj.describe(description, revision));
        ctx.repo.refresh({ reason: 'after describe' });
        return description;
    } catch (e: unknown) {
        await ctx.ui.showError(e, 'Error setting description');
        return false;
    }
}
