/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export async function undoCommand(ctx: CommandContext): Promise<void> {
    const {
        repo,
        host: { ui },
    } = ctx;
    try {
        await ui.withProgress('Undoing...', () => repo.jj.undo());
        await repo.refresh({ reason: 'undo' });
    } catch (e: unknown) {
        await showJjError(ui, e, 'Error undoing', repo.jj, ctx.log);
    }
}
