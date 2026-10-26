/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export interface ResolvedSyncCommand {
    subcommand: string;
    commandArgs: string[];
}

export function resolveSyncCommand(customCommand?: string): ResolvedSyncCommand {
    const trimmedCommand = customCommand?.trim() || 'git fetch';
    const [subcommand, ...commandArgs] = trimmedCommand.split(/\s+/);
    return { subcommand, commandArgs };
}

export async function syncCommand(ctx: CommandContext): Promise<void> {
    const {
        repo,
        host: { ui, nav, config },
    } = ctx;
    const customCommand = config.get<string>('syncCommand');
    const trimmedCustom = customCommand?.trim();
    const hasCustomCommand = !!(trimmedCustom && trimmedCustom.length > 0 && trimmedCustom !== 'git fetch');

    try {
        const { subcommand, commandArgs } = resolveSyncCommand(customCommand);

        await ui.withProgress('Syncing...', () => repo.jj.sync(subcommand, ...commandArgs));

        await repo.refresh({ reason: 'sync' });
        repo.codeForge?.requestRefreshWithBackoffs?.();

        await ui.showInformation('Sync successful');
    } catch (e: unknown) {
        const CONFIGURE = 'Configure Sync...';
        const extraActions = hasCustomCommand ? [] : [CONFIGURE];
        const selection = await showJjError(ui, e, 'Sync failed', repo.jj, ctx.log, extraActions);

        if (selection === CONFIGURE) {
            await nav.openSettings('jj-view.syncCommand');
        }
    }
}
