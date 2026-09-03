/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import type { JjRepository } from '../jj-repository';

export interface UploadPayload {
    revision?: string;
}

interface ResolvedUploadCommand {
    subcommand: string;
    commandArgs: string[];
    uploadRevision?: string;
}

async function checkHasLocalBookmark(jj: JjRepository['jj'], revision: string): Promise<boolean> {
    try {
        const bookmarks = await jj.getBookmarks({ revision });
        return bookmarks.some((b) => !b.remote);
    } catch {
        return false;
    }
}

async function resolveUploadCommand(
    repo: JjRepository,
    revision?: string,
    customCommand?: string,
): Promise<ResolvedUploadCommand> {
    const trimmedCommand = customCommand?.trim();
    if (trimmedCommand) {
        const [subcommand, ...commandArgs] = trimmedCommand.split(/\s+/);
        return { subcommand, commandArgs, uploadRevision: revision };
    }

    const { activeProvider } = repo.codeForge;
    if (!activeProvider?.getUploadCommand) {
        return { subcommand: 'git', commandArgs: ['push'], uploadRevision: revision };
    }

    const rev = revision || '@';
    const hasBookmark = await checkHasLocalBookmark(repo.jj, rev);
    const provCommand = activeProvider.getUploadCommand(rev, hasBookmark);
    if (!provCommand) {
        return { subcommand: 'git', commandArgs: ['push'], uploadRevision: revision };
    }

    return {
        subcommand: provCommand.subcommand,
        commandArgs: provCommand.args,
        uploadRevision: undefined,
    };
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
        const { subcommand, commandArgs, uploadRevision } = await resolveUploadCommand(repo, revision, customCommand);

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
