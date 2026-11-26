/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { isRootCommit } from '../../utils/jj-utils';
import type { CommandContext } from '../host/command-context';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import { RevisionQuery } from './command-utils';

export interface ShowDetailsPayload {
    revision?: string;
}

export async function showDetailsCommand(ctx: CommandContext, payload?: ShowDetailsPayload): Promise<void> {
    const {
        repo,
        host: { ui, nav },
    } = ctx;
    const { jj } = repo;

    try {
        let revision = payload?.revision?.trim();
        if (!revision) {
            const prompted = await promptForRevision(ui, jj, {
                placeHolder: 'Select or enter a revision to view details',
                emptyPrompt: 'Enter a revision expression to view details',
                revisionQuery: RevisionQuery.visibleNonRoot(),
                repoRoot: repo.rootUri,
                nav,
            });
            revision = prompted?.trim();
        }

        if (!revision) {
            return;
        }

        const entries = await ui.withProgress('Loading details...', () =>
            jj.getLog({ revision, limit: 2, omitChanges: true }),
        );
        if (entries.length === 0) {
            throw new Error(`No log entry found for revision: ${revision}`);
        }
        if (entries.length > 1) {
            throw new Error(
                `Revision "${revision}" matched multiple commits. Specify a single revision (e.g. a commit ID or divergent offset).`,
            );
        }
        const [logEntry] = entries;
        if (isRootCommit(logEntry)) {
            void ui.showInformation('Commit details are not available for the root commit.');
            return;
        }
        await nav.openCommitDetails(
            repo.rootUri,
            logEntry.change_id,
            logEntry.change_id_shortest,
            logEntry.is_divergent,
            logEntry.change_id_offset,
        );
    } catch (e: unknown) {
        await showJjError(ui, e, 'Error showing details', jj, ctx.log);
    }
}
