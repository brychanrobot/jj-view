/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { StackCommitNode } from '../code-forge-provider';
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import type { JjRepository } from '../jj-repository';
import type { JjService } from '../jj-service';
import type { JjLogEntry } from '../jj-types';
import type { UploadPayload } from './upload';

export interface ResolvedStackedUploadCommand {
    subcommand: string;
    commandArgs: string[];
    stackCommits: JjLogEntry[];
}

export function toStackCommitNodes(commits: JjLogEntry[]): StackCommitNode[] {
    const nodes: StackCommitNode[] = [];
    for (const commit of commits) {
        const local = commit.bookmarks?.filter((b) => !b.remote) ?? [];
        const nonEphemeral = local.find((b) => !b.name.startsWith('push-'));
        const remoteBookmark = commit.bookmarks?.find((b) => b.remote);
        const bookmarkName = nonEphemeral?.name ?? local[0]?.name ?? remoteBookmark?.name;
        if (bookmarkName) {
            nodes.push({
                commitId: commit.commit_id,
                changeId: commit.change_id,
                description: commit.description,
                bookmark: bookmarkName,
            });
        }
    }
    return nodes;
}

export async function resolveStackCommits(jj: JjService, targetRevision: string): Promise<JjLogEntry[]> {
    try {
        let target = targetRevision || '@';
        const currentEntries = await jj.getLog({ revision: '@' });
        const current = currentEntries[0];
        const isTargetWorkingCopy =
            target === '@' || (current && (current.change_id === target || current.commit_id === target));
        if (isTargetWorkingCopy && current?.is_empty && (!current.bookmarks || current.bookmarks.length === 0)) {
            target = '@-';
        }
        const log = await jj.getLog({ revision: `roots(immutable()..(${target}))::(${target})` });
        // getLog returns commits from top (descendant) to bottom (ancestor). Reverse to get topological order [root, ..., target].
        return [...log].reverse();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        jj.logger.debug(`[resolveStackCommits] Failed to resolve stack commits for '${targetRevision}': ${msg}`);
        return [];
    }
}

export function isLinearCommitChain(commits: JjLogEntry[]): boolean {
    for (let i = 1; i < commits.length; i++) {
        const commit = commits[i];
        const prev = commits[i - 1];
        if (!commit.parents || commit.parents.length !== 1 || commit.parents[0].commit_id !== prev.commit_id) {
            return false;
        }
    }
    return true;
}

export function isEligibleForAutoStackedUpload(commits: JjLogEntry[]): boolean {
    if (commits.length <= 1) {
        return false;
    }
    const allHaveBookmarks = commits.every((c) => c.bookmarks?.some((b) => !b.remote));
    if (!allHaveBookmarks) {
        return false;
    }
    return isLinearCommitChain(commits);
}

export function buildStackPushArgs(commits: JjLogEntry[]): string[] {
    const args: string[] = [];
    for (const commit of commits) {
        const local = commit.bookmarks?.filter((b) => !b.remote) ?? [];
        const nonEphemeral = local.find((b) => !b.name.startsWith('push-'));
        const chosen = nonEphemeral ?? local[0];
        if (chosen) {
            args.push('-r', chosen.name);
        } else {
            args.push('-c', commit.change_id);
        }
    }
    return args;
}

export async function resolveStackedUploadCommand(
    repo: JjRepository,
    targetRevision: string,
    customCommand?: string,
    preResolvedStackCommits?: JjLogEntry[],
): Promise<ResolvedStackedUploadCommand> {
    if (repo.codeForge.activeProvider?.id === 'gerrit') {
        throw new Error('Stacked uploads are not supported for Gerrit repositories. Use standard upload instead.');
    }

    const matchesTarget = preResolvedStackCommits?.some(
        (c) =>
            c.commit_id === targetRevision ||
            c.change_id === targetRevision ||
            c.commit_id.startsWith(targetRevision) ||
            c.change_id.startsWith(targetRevision) ||
            (targetRevision === '@' && c.is_current_working_copy),
    );
    const stackCommits =
        preResolvedStackCommits && (matchesTarget || targetRevision === '@')
            ? preResolvedStackCommits
            : await resolveStackCommits(repo.jj, targetRevision);
    if (stackCommits.length === 0) {
        throw new Error('No mutable commits found in stack to upload.');
    }

    if (!isLinearCommitChain(stackCommits)) {
        throw new Error(
            'Stacked upload requires a linear sequence of commits. Merges or branched commits are not supported.',
        );
    }

    const stackArgs = buildStackPushArgs(stackCommits);
    const trimmedCommand = customCommand?.trim();
    if (trimmedCommand) {
        const [subcommand, ...commandArgs] = trimmedCommand.split(/\s+/);
        return {
            subcommand,
            commandArgs: [...commandArgs, ...stackArgs],
            stackCommits,
        };
    }

    return {
        subcommand: 'git',
        commandArgs: ['push', ...stackArgs],
        stackCommits,
    };
}

export async function uploadStackCommand(ctx: CommandContext, payload?: UploadPayload): Promise<void> {
    const {
        repo,
        host: { ui, nav, config },
    } = ctx;
    if (repo.codeForge.activeProvider?.id === 'gerrit') {
        await ui.showWarning('Stacked uploads are not supported for Gerrit repositories. Use standard upload instead.');
        return;
    }

    const revision = payload?.revision ?? '@';
    const customCommand = config.get<string>('uploadCommand');
    const hasCustomCommand = !!(customCommand && customCommand.trim().length > 0);

    let resolved: ResolvedStackedUploadCommand;
    try {
        resolved = await resolveStackedUploadCommand(repo, revision, customCommand, payload?.stackCommits);
        if (!resolved.subcommand) {
            throw new Error('Invalid upload command configuration.');
        }

        const prepareStackedChanges = repo.codeForge.activeProvider?.prepareStackedChanges?.bind(
            repo.codeForge.activeProvider,
        );
        if (prepareStackedChanges) {
            const initialStackNodes = toStackCommitNodes(resolved.stackCommits);
            if (initialStackNodes.length > 1) {
                try {
                    await ui.withProgress('Preparing stack on remote...', () =>
                        prepareStackedChanges(initialStackNodes),
                    );
                } catch (prepErr: unknown) {
                    const msg = prepErr instanceof Error ? prepErr.message : String(prepErr);
                    ctx.log?.warn(`[uploadStack] Pre-push stack preparation encountered an issue: ${msg}`);
                }
            }
        }

        const title = `Uploading stack (${resolved.stackCommits.length} commits)...`;
        await ui.withProgress(title, () => repo.jj.upload(undefined, resolved.subcommand, ...resolved.commandArgs));
    } catch (e: unknown) {
        const CONFIGURE = 'Configure Upload...';
        const extraActions = hasCustomCommand ? [] : [CONFIGURE];
        const selection = await showJjError(ui, e, 'Upload failed', repo.jj, ctx.log, extraActions);

        if (selection === CONFIGURE) {
            await nav.openSettings('jj-view.uploadCommand');
        }
        return;
    }

    await repo.refresh();
    repo.codeForge.requestRefreshWithBackoffs();

    const syncStackedChanges = repo.codeForge.activeProvider?.syncStackedChanges?.bind(repo.codeForge.activeProvider);
    if (!syncStackedChanges) {
        await ui.showInformation('Upload successful');
        return;
    }

    try {
        const updatedCommits = await resolveStackCommits(repo.jj, revision);
        const stackNodes = toStackCommitNodes(updatedCommits);

        if (stackNodes.length > 0) {
            const syncResult = await ui.withProgress('Synchronizing pull requests...', () =>
                syncStackedChanges(stackNodes),
            );

            const parts: string[] = [];
            if (syncResult.created.length > 0) {
                const createdDetails = syncResult.created.map((p) => `#${p.prNumber}`).join(', ');
                parts.push(`Created: ${createdDetails}`);
            }
            if (syncResult.retargeted.length > 0) {
                const retargetedDetails = syncResult.retargeted.map((p) => `#${p.prNumber}`).join(', ');
                parts.push(`Retargeted: ${retargetedDetails}`);
            }

            if (parts.length > 0) {
                await ui.showInformation(`Upload successful. ${parts.join('; ')}`);
                return;
            }
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log?.error(`[uploadStack] Pull request synchronization failed: ${msg}`);
        await ui.showWarning(`Upload succeeded, but pull request synchronization failed: ${msg}`);
        return;
    }

    await ui.showInformation('Upload successful');
}
