/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import type { JjRepository } from '../jj-repository';
import type { JjService } from '../jj-service';
import type { JjLogEntry } from '../jj-types';
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
    stackCommits?: JjLogEntry[];
}

interface ResolvedUploadCommand {
    subcommand: string;
    commandArgs: string[];
    uploadRevision?: string;
}

async function checkHasLocalBookmark(jj: JjService, revision: string, stackCommits?: JjLogEntry[]): Promise<boolean> {
    if (stackCommits && stackCommits.length > 0) {
        const commit = stackCommits.find(
            (c) =>
                c.commit_id === revision ||
                c.change_id === revision ||
                c.commit_id.startsWith(revision) ||
                c.change_id.startsWith(revision) ||
                (revision === '@' && c.is_current_working_copy),
        );
        if (commit?.bookmarks) {
            return commit.bookmarks.some((b) => !b.remote);
        }
    }
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
    stackCommits?: JjLogEntry[],
): Promise<ResolvedUploadCommand> {
    let rev = revision || '@';
    if (rev === '@') {
        const currentEntries = await repo.jj.getLog({ revision: '@', omitChanges: true, limit: 1 });
        const current = currentEntries[0];
        if (current?.is_empty && (!current.bookmarks || current.bookmarks.length === 0)) {
            rev = '@-';
        }
    }
    const trimmedCommand = customCommand?.trim();
    if (trimmedCommand) {
        const [subcommand, ...commandArgs] = trimmedCommand.split(/\s+/);
        return { subcommand, commandArgs, uploadRevision: rev };
    }

    const { activeProvider } = repo.codeForge;
    if (!activeProvider?.getUploadCommand) {
        return { subcommand: 'git', commandArgs: ['push'], uploadRevision: rev };
    }

    const hasBookmark = await checkHasLocalBookmark(repo.jj, rev, stackCommits);
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

    let stackCommits = payload?.stackCommits;

    if (mode === 'stack') {
        return uploadStackCommand(ctx, { ...payload, mode: 'stack', stackCommits });
    }

    if (mode === 'auto') {
        if (!stackCommits) {
            stackCommits = await resolveStackCommits(repo.jj, revision ?? '@');
        }
        if (isEligibleForAutoStackedUpload(stackCommits)) {
            return uploadStackCommand(ctx, { ...payload, mode: 'stack', stackCommits });
        }
    }

    const customCommand = config.get<string>('uploadCommand');
    const hasCustomCommand = !!(customCommand && customCommand.trim().length > 0);
    try {
        const { subcommand, commandArgs, uploadRevision } = await resolveUploadCommand(
            repo,
            revision,
            customCommand,
            stackCommits,
        );

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
