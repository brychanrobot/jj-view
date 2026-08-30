/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import { RevisionQuery } from './command-utils';

export interface SquashFilesIntoParentPayload {
    paths: string[];
    revision?: string;
}

export interface SquashFilesIntoAncestorPayload {
    paths: string[];
    revision?: string;
    ancestorRevision?: string;
}

export interface SquashFilesIntoChildPayload {
    paths: string[];
    revision?: string;
    childRevision?: string;
}

export async function squashFilesIntoParentCommand(
    ctx: CommandContext,
    payload?: SquashFilesIntoParentPayload,
): Promise<void> {
    const paths = payload?.paths ?? [];
    if (paths.length === 0) {
        return;
    }

    const revision = payload?.revision || '@';

    try {
        await ctx.host.ui.withProgress('Squashing file(s) into parent...', () =>
            ctx.repo.jj.squashRevision({ paths, revision, useDestinationMessage: true }),
        );
        await ctx.repo.refresh({ reason: 'after squash file(s) into parent' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error squashing file(s) into parent', ctx.repo.jj, ctx.log);
    }
}

export async function squashFilesIntoAncestorCommand(
    ctx: CommandContext,
    payload?: SquashFilesIntoAncestorPayload,
): Promise<void> {
    const paths = payload?.paths ?? [];
    if (paths.length === 0) {
        return;
    }

    const revision = payload?.revision || '@';

    try {
        let selectedAncestorRev = payload?.ancestorRevision;
        if (!selectedAncestorRev) {
            selectedAncestorRev = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
                placeHolder: 'Select which ancestor to squash into',
                revisionQuery: RevisionQuery.mutableAncestorsExcluding(revision),
            });
        }
        if (!selectedAncestorRev) {
            return;
        }

        await ctx.host.ui.withProgress('Squashing file(s) into ancestor...', () =>
            ctx.repo.jj.squashRevision({
                paths,
                revision,
                intoRevision: selectedAncestorRev,
                useDestinationMessage: true,
            }),
        );
        await ctx.repo.refresh({ reason: 'after squash file(s) into ancestor' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error squashing file(s) into ancestor', ctx.repo.jj, ctx.log);
    }
}

export async function squashFilesIntoChildCommand(
    ctx: CommandContext,
    payload?: SquashFilesIntoChildPayload,
): Promise<void> {
    const paths = payload?.paths ?? [];
    if (paths.length === 0) {
        return;
    }

    const revision = payload?.revision || '@';

    try {
        const children = await ctx.repo.jj.getChildren(revision);
        let targetChild = payload?.childRevision;

        if (!targetChild) {
            if (children.length === 0) {
                const revDisplay = revision === '@' ? 'the working copy' : revision;
                await showJjError(
                    ctx.host.ui,
                    new Error(`No child commits to squash changes into for ${revDisplay}.`),
                    'Squash Error',
                    ctx.repo.jj,
                    ctx.log,
                );
                return;
            } else if (children.length === 1) {
                targetChild = children[0];
            } else {
                targetChild = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
                    placeHolder: `Select child commit for ${revision}`,
                    revisionQuery: RevisionQuery.children(revision),
                });
            }
        }

        if (!targetChild) {
            return;
        }

        await ctx.host.ui.withProgress('Squashing file(s) into child...', () =>
            ctx.repo.jj.squashRevision({
                paths,
                revision,
                intoRevision: targetChild,
                useDestinationMessage: true,
            }),
        );
        await ctx.repo.refresh({ reason: 'after squash file(s) into child' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error squashing file(s) into child', ctx.repo.jj, ctx.log);
    }
}
