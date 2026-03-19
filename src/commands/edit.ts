/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JjService } from '../jj-service';
import { extractRevision, showJjError, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function editCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const revision = extractRevision(args);
    if (!revision) {
        return;
    }

    try {
        await withDelayedProgress('Editing...', jj.edit(revision));
        await scmProvider.refresh({ reason: 'after edit' });
    } catch (e: unknown) {
        await showJjError(e, 'Error editing commit', jj, scmProvider.outputChannel);
    }
}
