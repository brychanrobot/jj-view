/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../common/command-context';
import { createDiffUris } from '../uri-utils';

export interface ShowMultiFileDiffPayload {
    revision?: string;
}

export async function showMultiFileDiffCommand(ctx: CommandContext, payload?: ShowMultiFileDiffPayload): Promise<void> {
    try {
        const revision = payload?.revision || '@';

        await ctx.ui.withProgress(`Preparing multi-file diff for ${revision}...`, async (): Promise<void> => {
            const { jj } = ctx.repo;
            // Resolve to concrete change ID so both diff sides use the jj-view content provider
            const [logEntry] = await jj.getLog({ revision, limit: 1 });
            const changeId = logEntry?.change_id ?? revision;
            const editable = logEntry ? !logEntry.is_immutable : false;

            const [changes, description] = await Promise.all([
                jj.getChanges(changeId),
                jj.getDescription(changeId),
                jj.getDiffForRevision(revision),
            ]);

            if (changes.length === 0) {
                await ctx.ui.showInformation(`No changes found in revision ${changeId}.`);
                return;
            }

            const resources = changes.map((entry) => {
                const { leftUri, rightUri } = createDiffUris(entry, changeId, jj.workspaceRoot, { editable });
                return { leftUri, rightUri, label: entry.path };
            });

            const firstLine = description.split('\n')[0].trim();
            const shortId = changeId.slice(0, 8);
            const title = firstLine ? `${shortId}: ${firstLine}` : `Changes in ${shortId}`;
            await ctx.nav.openMultiDiff(title, resources);
        });
    } catch (err: unknown) {
        await ctx.ui.showError(err, 'Failed to open multi-file diff');
    }
}
