/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';

export async function undoCommand(ctx: CommandContext): Promise<void> {
    const { repo, ui } = ctx;
    try {
        await ui.withProgress('Undoing...', () => repo.jj.undo());
        await repo.refresh({ reason: 'undo' });
    } catch (e: unknown) {
        await ui.showError(e, 'Error undoing');
    }
}
