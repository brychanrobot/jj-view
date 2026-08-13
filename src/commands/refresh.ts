/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';

export async function refreshCommand(ctx: CommandContext): Promise<void> {
    try {
        await ctx.repo.refresh({ reason: 'manual refresh command', forceSnapshot: true });
    } catch (err: unknown) {
        await ctx.ui.showError(err, 'Error refreshing');
    }
}
