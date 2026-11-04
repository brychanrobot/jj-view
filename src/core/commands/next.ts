/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export async function nextCommand(ctx: CommandContext): Promise<void> {
    const {
        repo,
        host: { ui },
    } = ctx;
    try {
        await ui.withProgress('Moving to next change...', () => repo.jj.next());
        await repo.refresh({ reason: 'next' });
    } catch (e: unknown) {
        await showJjError(ui, e, 'Error moving to next change', repo.jj, ctx.log);
    }
}
