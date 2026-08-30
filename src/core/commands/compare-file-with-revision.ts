/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import type { CommandContext } from '../host/command-context';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import { createRevisionUri, type Uri } from '../uri-utils';
import { RevisionQuery } from './command-utils';

export interface CompareFileWithRevisionPayload {
    fileUri?: Uri;
    revision?: string;
}

export async function compareFileWithRevisionCommand(
    ctx: CommandContext,
    payload?: CompareFileWithRevisionPayload,
): Promise<void> {
    try {
        const fileUri = payload?.fileUri;

        if (!fileUri || fileUri.scheme !== 'file') {
            await showJjError(
                ctx.host.ui,
                new Error('No workspace file selected for comparison.'),
                'Compare File Error',
                ctx.repo.jj,
                ctx.log,
            );
            return;
        }

        let revision = payload?.revision;
        if (!revision) {
            revision = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
                placeHolder: `Select an ancestor to compare ${path.basename(fileUri.fsPath)} with`,
                emptyPrompt: `Compare ${path.basename(fileUri.fsPath)} with revision`,
                revisionQuery: RevisionQuery.ancestorsExcluding('@'),
            });
        }

        if (!revision) {
            return;
        }

        const { jj } = ctx.repo;
        const leftUri = createRevisionUri(jj.workspaceRoot, fileUri.fsPath, revision);

        const title = `${path.basename(fileUri.fsPath)} (${revision} ↔ Working Copy)`;
        await ctx.host.nav.openDiff(leftUri, fileUri, title);
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Failed to compare file', ctx.repo.jj, ctx.log);
    }
}
