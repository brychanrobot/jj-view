/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export async function prevCommand(ctx: CommandContext): Promise<void> {
    const {
        repo,
        host: { ui },
    } = ctx;
    try {
        await ui.withProgress('Moving to previous change...', () => repo.jj.prev());
        await repo.refresh({ reason: 'prev' });
    } catch (e: unknown) {
        await showJjError(ui, e, 'Error moving to previous change', repo.jj, ctx.log);
    }
}
