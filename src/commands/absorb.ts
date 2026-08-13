/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../common/command-context';

export interface AbsorbPayload {
    paths?: string[];
    fromRevision?: string;
}

export async function absorbCommand(ctx: CommandContext, payload?: AbsorbPayload): Promise<void> {
    const paths = payload?.paths ?? [];
    const fromRevision = payload?.fromRevision;

    try {
        await ctx.ui.withProgress('Absorbing changes...', () => ctx.repo.jj.absorb({ paths, fromRevision }));
        await ctx.repo.refresh({ reason: 'after absorb' });
        ctx.ui.setStatusBarMessage?.('Absorb completed.', 3000);
    } catch (e: unknown) {
        await ctx.ui.showError(e, 'Absorb failed');
    }
}
