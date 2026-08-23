/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import type { CommandContext } from '../common/command-context';
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
            await ctx.host.ui.showError(new Error('No workspace file selected for comparison.'), 'Compare File Error');
            return;
        }

        let revision = payload?.revision;
        if (!revision) {
            revision = await ctx.host.ui.promptForRevision({
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
        await ctx.host.ui.showError(err, 'Failed to compare file');
    }
}
