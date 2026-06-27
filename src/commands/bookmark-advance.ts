/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { extractRevision, promptForRevision, RevisionQuery, showJjError, withDelayedProgress } from './command-utils';

export async function advanceBookmarkCommand(
    scmProvider: JjScmProvider,
    jj: JjService,
    args: unknown[],
): Promise<string | undefined> {
    let revision = extractRevision(args);

    if (!revision) {
        revision = await promptForRevision(jj, {
            placeHolder: 'Select target revision to advance bookmarks to',
            emptyPrompt: 'Enter revision',
            revisionQuery: RevisionQuery.ancestorsIncluding('@'),
        });
    }

    if (!revision) {
        return undefined; // User cancelled
    }

    try {
        await withDelayedProgress(
            `Advancing bookmarks to ${revision.substring(0, 8)}...`,
            jj.advanceBookmark(revision),
        );
        await scmProvider.refresh({ reason: 'after bookmark advance' });
        return revision;
    } catch (e: unknown) {
        await showJjError(e, 'Error advancing bookmarks', jj, scmProvider.outputChannel);
        throw e;
    }
}
