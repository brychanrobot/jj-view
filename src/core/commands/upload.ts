/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export interface UploadPayload {
    revision?: string;
}

export async function uploadCommand(ctx: CommandContext, payload?: UploadPayload): Promise<void> {
    const {
        repo,
        host: { ui, nav, config },
    } = ctx;
    const revision = payload?.revision;
    const customCommand = config.get<string>('uploadCommand');
    const hasCustomCommand = !!(customCommand && customCommand.trim().length > 0);
    try {
        let subcommand = '';
        let commandArgs: string[] = [];
        let uploadRevision: string | undefined = revision;

        if (hasCustomCommand) {
            const commandStr = customCommand?.trim() || '';
            const [first, ...rest] = commandStr.split(/\s+/);
            subcommand = first;
            commandArgs = rest;
        } else {
            const { codeForge, jj } = repo;
            const { activeProvider } = codeForge;
            if (activeProvider?.getUploadCommand) {
                const rev = revision || '@';
                let hasBookmark = false;
                try {
                    const bookmarks = await jj.getBookmarks({ revision: rev });
                    hasBookmark = bookmarks.some((b) => !b.remote);
                } catch (_err) {
                    // Ignore errors (e.g. revision doesn't exist yet) and default to false
                }
                const provCommand = activeProvider.getUploadCommand(rev, hasBookmark);
                if (provCommand) {
                    subcommand = provCommand.subcommand;
                    commandArgs = provCommand.args;
                    uploadRevision = undefined; // The provider handles revision in its args, don't append -r again
                } else {
                    subcommand = 'git';
                    commandArgs = ['push'];
                }
            } else {
                subcommand = 'git';
                commandArgs = ['push'];
            }
        }

        if (!subcommand) {
            await showJjError(ui, new Error('Invalid upload command configuration.'), 'Upload Error', repo.jj, ctx.log);
            return;
        }

        const displayRev = revision || '@';
        const title = displayRev ? `Uploading revision ${displayRev.substring(0, 8)}...` : 'Uploading...';
        await ui.withProgress(title, () => repo.jj.upload(uploadRevision, subcommand, ...commandArgs));

        await repo.refresh();
        repo.codeForge.requestRefreshWithBackoffs();
        await ui.showInformation('Upload successful');
    } catch (e: unknown) {
        const CONFIGURE = 'Configure Upload...';
        const extraActions = hasCustomCommand ? [] : [CONFIGURE];
        const selection = await showJjError(ui, e, 'Upload failed', repo.jj, ctx.log, extraActions);

        if (selection === CONFIGURE) {
            await nav.openSettings('jj-view.uploadCommand');
        }
    }
}
