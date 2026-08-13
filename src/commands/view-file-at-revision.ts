/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import type { CommandContext } from '../common/command-context';
import { createRevisionUri, type Uri } from '../uri-utils';
import { RevisionQuery } from './command-utils';

export interface ViewFileAtRevisionPayload {
    fileUri?: Uri;
    revision?: string;
}

export async function viewFileAtRevisionCommand(
    ctx: CommandContext,
    payload?: ViewFileAtRevisionPayload,
): Promise<void> {
    try {
        const fileUri = payload?.fileUri;

        if (!fileUri || fileUri.scheme !== 'file') {
            await ctx.ui.showError(new Error('No workspace file selected.'), 'View File Error');
            return;
        }

        let revision = payload?.revision;
        if (!revision) {
            revision = await ctx.ui.promptForRevision({
                placeHolder: `Select a revision to view ${path.basename(fileUri.fsPath)} at`,
                revisionQuery: RevisionQuery.visible(),
            });
        }

        if (!revision) {
            return;
        }

        const { jj } = ctx.repo;
        const revisionUri = createRevisionUri(jj.workspaceRoot, fileUri.fsPath, revision);

        await ctx.nav.openFile(revisionUri);
    } catch (err: unknown) {
        await ctx.ui.showError(err, 'Failed to view file at revision');
    }
}
