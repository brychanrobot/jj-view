/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';

export async function redoCommand(ctx: CommandContext): Promise<void> {
    const {
        repo,
        host: { ui },
    } = ctx;
    try {
        await ui.withProgress('Redoing...', () => repo.jj.redo());
        await repo.refresh({ reason: 'redo' });
    } catch (e: unknown) {
        await ui.showError(e, 'Error redoing');
    }
}
