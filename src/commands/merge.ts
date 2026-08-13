/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import { RevisionQuery } from './command-utils';

export interface MergeCommandArg {
    revision: string;
}

export interface NewMergeChangePayload {
    revisions?: string[];
}

export async function newMergeChangeCommand(ctx: CommandContext, payload?: NewMergeChangePayload): Promise<void> {
    const revisions: string[] = payload?.revisions ? [...payload.revisions] : [];

    if (revisions.length === 0) {
        const rev1 = await ctx.ui.promptForRevision({
            placeHolder: 'Select first revision for merge (optional)',
            revisionQuery: RevisionQuery.visible(),
        });
        if (rev1) {
            revisions.push(rev1);
        }
        const rev2 = await ctx.ui.promptForRevision({
            placeHolder: 'Select second revision for merge (optional)',
            revisionQuery: RevisionQuery.visible(),
        });
        if (rev2) {
            revisions.push(rev2);
        }
    }

    if (revisions.length < 1) {
        await ctx.ui.showError(new Error('Need at least 1 revision to create a change.'), 'Merge Error');
        return;
    }

    try {
        await ctx.repo.jj.new({ parents: revisions });
        await ctx.repo.refresh();
    } catch (e: unknown) {
        await ctx.ui.showError(e, 'Failed to create merge');
    }
}
