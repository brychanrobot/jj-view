/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import { createDiffUris } from '../uri-utils';

export interface ShowMultiFileDiffPayload {
    revision?: string;
}

export async function showMultiFileDiffCommand(ctx: CommandContext, payload?: ShowMultiFileDiffPayload): Promise<void> {
    try {
        const revision = payload?.revision || '@';

        await ctx.host.ui.withProgress(`Preparing multi-file diff for ${revision}...`, async (): Promise<void> => {
            const { jj } = ctx.repo;
            // Resolve to concrete change ID so both diff sides use the jj-view content provider
            const [logEntry] = await jj.getLog({ revision, limit: 1, omitChanges: true });
            const changeId = logEntry?.change_id ?? revision;
            const editable = logEntry ? !logEntry.is_immutable : false;
            const description = logEntry?.description ?? (await jj.getDescription(changeId));

            const changes = await jj.getChanges(changeId);

            if (changes.length === 0) {
                await ctx.host.ui.showInformation(`No changes found in revision ${changeId}.`);
                return;
            }

            const resources = changes.map((entry) => {
                const { leftUri, rightUri } = createDiffUris(entry, changeId, jj.workspaceRoot, { editable });
                return { leftUri, rightUri, label: entry.path };
            });

            const firstLine = description.split('\n')[0].trim();
            const shortId = changeId.slice(0, 8);
            const title = firstLine ? `${shortId}: ${firstLine}` : `Changes in ${shortId}`;
            await ctx.host.nav.openMultiDiff(title, resources);
        });
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Failed to open multi-file diff', ctx.repo.jj, ctx.log);
    }
}
