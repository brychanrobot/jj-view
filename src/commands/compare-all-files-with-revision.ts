/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { CommandContext } from '../common/command-context';
import { createRevisionUri, Uri } from '../uri-utils';
import { RevisionQuery } from './command-utils';

export interface CompareAllFilesWithRevisionPayload {
    revision?: string;
}

export async function compareAllFilesWithRevisionCommand(
    ctx: CommandContext,
    payload?: CompareAllFilesWithRevisionPayload,
): Promise<void> {
    try {
        let revision = payload?.revision;
        if (!revision) {
            revision = await ctx.ui.promptForRevision({
                placeHolder: 'Select an ancestor to compare with all files',
                revisionQuery: RevisionQuery.ancestorsExcluding('@'),
            });
        }

        if (!revision) {
            return;
        }

        const rev = revision;
        const { jj } = ctx.repo;

        await ctx.ui.withProgress(`Comparing ${rev} with all files...`, async (): Promise<void> => {
            const changes = await jj.getChangesBetween(rev, '@');

            if (changes.length === 0) {
                await ctx.ui.showInformation(`No differences found between ${rev} and working copy.`);
                return;
            }

            const resources = changes.map((entry) => {
                const isAdded = entry.status === 'added';
                const isDeleted = entry.status === 'deleted';

                const leftPath = entry.oldPath || entry.path;
                const rightPath = entry.path;

                const leftUri = createRevisionUri(jj.workspaceRoot, leftPath, isAdded ? 'none' : rev);
                const rightUri = isDeleted
                    ? createRevisionUri(jj.workspaceRoot, rightPath, 'none')
                    : Uri.file(path.join(jj.workspaceRoot, rightPath));

                return { leftUri, rightUri, label: rightPath };
            });

            const title = `Compare ${rev} with Working Copy`;
            await ctx.nav.openMultiDiff(title, resources);
        });
    } catch (err: unknown) {
        await ctx.ui.showError(err, 'Failed to open comparison');
    }
}
