/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import { showJjError } from '../common/ui-helpers';
import type { JjResourceState } from '../scm-resource-state';

export interface OpenMergeEditorPayload {
    resourceStates: JjResourceState[];
}

export async function openMergeEditorCommand(ctx: CommandContext, payload?: OpenMergeEditorPayload): Promise<void> {
    const resourceStates = payload?.resourceStates ?? [];

    if (resourceStates.length === 0) {
        ctx.log.warn('jj-view.openMergeEditor: No valid resource states provided');
        return;
    }

    try {
        const r = resourceStates[0];
        if (r?.resourceUri) {
            await ctx.host.nav.openMergeEditor(r.resourceUri);
        }
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error opening merge editor', ctx.repo.jj, ctx.log);
    }
}
