/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../common/command-context';
import { showJjError } from '../common/ui-helpers';

export interface AbsorbPayload {
    paths?: string[];
    fromRevision?: string;
}

export async function absorbCommand(ctx: CommandContext, payload?: AbsorbPayload): Promise<void> {
    const paths = payload?.paths ?? [];
    const fromRevision = payload?.fromRevision;

    try {
        await ctx.host.ui.withProgress('Absorbing changes...', () => ctx.repo.jj.absorb({ paths, fromRevision }));
        await ctx.repo.refresh({ reason: 'after absorb' });
        ctx.host.ui.setStatusBarMessage?.('Absorb completed.', 3000);
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Absorb failed', ctx.repo.jj, ctx.log);
    }
}
