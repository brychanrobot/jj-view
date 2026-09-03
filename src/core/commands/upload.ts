/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import type { JjRepository } from '../jj-repository';
import type { JjService } from '../jj-service';
import {
    buildStackPushArgs,
    isEligibleForAutoStackedUpload,
    isLinearCommitChain,
    resolveStackCommits,
    resolveStackedUploadCommand,
    toStackCommitNodes,
    uploadStackCommand,
} from './upload-stack';

export {
    buildStackPushArgs,
    isEligibleForAutoStackedUpload,
    isLinearCommitChain,
    resolveStackCommits,
    resolveStackedUploadCommand,
    toStackCommitNodes,
    uploadStackCommand,
};

export interface UploadPayload {
    revision?: string;
    mode?: 'auto' | 'single' | 'stack';
}

interface ResolvedUploadCommand {
    subcommand: string;
    commandArgs: string[];
    uploadRevision?: string;
}

async function checkHasLocalBookmark(jj: JjService, revision: string): Promise<boolean> {
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
    const rev = revision || '@';
    const trimmedCommand = customCommand?.trim();
    if (trimmedCommand) {
        const [subcommand, ...commandArgs] = trimmedCommand.split(/\s+/);
        return { subcommand, commandArgs, uploadRevision: rev };
    }

    const { activeProvider } = repo.codeForge;
    if (!activeProvider?.getUploadCommand) {
        return { subcommand: 'git', commandArgs: ['push'], uploadRevision: rev };
    }

    const hasBookmark = await checkHasLocalBookmark(repo.jj, rev);
    const provCommand = activeProvider.getUploadCommand(rev, hasBookmark);
    if (!provCommand) {
        return { subcommand: 'git', commandArgs: ['push'], uploadRevision: rev };
    }

    return {
        subcommand: provCommand.subcommand,
        commandArgs: provCommand.args,
        // The forge provider embeds the revision in its arguments, so upload() should not append -r again.
        uploadRevision: undefined,
    };
}

export async function uploadCommand(ctx: CommandContext, payload?: UploadPayload): Promise<void> {
    const {
        repo,
        host: { ui, nav, config },
    } = ctx;
    const revision = payload?.revision;
    const isGerrit = repo.codeForge.activeProvider?.id === 'gerrit';
    const alwaysUploadStack = !isGerrit && config.get<boolean>('alwaysUploadStack', false);
    const mode = isGerrit ? 'single' : alwaysUploadStack ? 'stack' : (payload?.mode ?? 'auto');

    if (mode === 'stack') {
        return uploadStackCommand(ctx, { ...payload, mode: 'stack' });
    }

    if (mode === 'auto') {
        const stackCommits = await resolveStackCommits(repo.jj, revision ?? '@');
        if (isEligibleForAutoStackedUpload(stackCommits)) {
            return uploadStackCommand(ctx, { ...payload, mode: 'stack' });
        }
    }

    const customCommand = config.get<string>('uploadCommand');
    const hasCustomCommand = !!(customCommand && customCommand.trim().length > 0);
    try {
        const { subcommand, commandArgs, uploadRevision } = await resolveUploadCommand(repo, revision, customCommand);

        if (!subcommand) {
            throw new Error('Invalid upload command configuration.');
        }

        const displayRev = revision ? (revision.length > 12 ? revision.substring(0, 8) : revision) : undefined;
        const title = displayRev ? `Uploading revision ${displayRev}...` : 'Uploading...';

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
