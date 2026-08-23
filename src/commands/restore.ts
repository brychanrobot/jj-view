/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';

export interface RestorePayload {
    pathsByRevision: Record<string, string[]>;
}

export async function restoreCommand(ctx: CommandContext, payload?: RestorePayload): Promise<void> {
    const pathsByRevision = payload?.pathsByRevision ?? {};
    const entries = Object.entries(pathsByRevision);

    if (entries.length === 0) {
        return;
    }

    try {
        for (const [rev, paths] of entries) {
            if (rev === '@') {
                await ctx.host.ui.withProgress('Restoring files...', () => ctx.repo.jj.restore(paths));
            } else {
                await ctx.host.ui.withProgress(`Restoring files for ${rev}...`, () =>
                    ctx.repo.jj.restore(paths, { changesIn: rev }),
                );
            }
        }
        await ctx.repo.refresh({ reason: 'after restore' });
    } catch (e: unknown) {
        await ctx.host.ui.showError(e, 'Error restoring files');
    }
}
