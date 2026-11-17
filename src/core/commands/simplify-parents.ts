/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import { RevisionQuery } from './command-utils';

export interface SimplifyParentsPayload {
    revisions?: string[];
}

export async function simplifyParentsCommand(ctx: CommandContext, payload?: SimplifyParentsPayload): Promise<void> {
    let revisions = Array.from(new Set((payload?.revisions ?? []).map((r) => r.trim()).filter((r) => r.length > 0)));

    if (revisions.length === 0) {
        const input = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
            placeHolder: 'Select revision to simplify parents',
            revisionQuery: RevisionQuery.mutable(),
            repoRoot: ctx.repo.rootUri,
            nav: ctx.host.nav,
        });
        const trimmed = input?.trim();
        if (!trimmed) {
            return;
        }
        revisions = [trimmed];
    }

    try {
        await ctx.host.ui.withProgress('Simplifying parents...', () => ctx.repo.jj.simplifyParents(revisions));
        await ctx.repo.refresh({ reason: 'simplifyParents' });
        void ctx.host.ui.showInformation(`Simplified parents for ${revisions.length} change(s).`);
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Failed to simplify parents', ctx.repo.jj, ctx.log);
    }
}
