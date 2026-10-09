/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export interface CommitMenuContext {
    commitId: string;
}

export interface RebaseOntoSelectedPayload {
    sourceId?: string;
    destinations?: string[];
}

export async function rebaseOntoSelectedCommand(
    ctx: CommandContext,
    payload?: RebaseOntoSelectedPayload,
): Promise<void> {
    const {
        repo,
        host: { ui },
    } = ctx;
    const sourceId = payload?.sourceId?.trim();
    if (!sourceId) {
        return;
    }

    const destinations = Array.from(
        new Set((payload?.destinations ?? []).map((id) => id.trim()).filter((id) => id.length > 0 && id !== sourceId)),
    );
    if (destinations.length === 0) {
        await showJjError(
            ui,
            new Error('No valid destination commits selected to rebase onto.'),
            'Rebase Error',
            repo.jj,
            ctx.log,
        );
        return;
    }

    try {
        await ui.withProgress(`Rebasing ${sourceId.substring(0, 8)} onto ${destinations.length} dest(s)...`, () =>
            repo.jj.rebase(sourceId, { target: destinations, mode: 'source' }),
        );
        await repo.refresh();
    } catch (err: unknown) {
        await showJjError(ui, err, 'Error rebasing', repo.jj, ctx.log);
    }
}
