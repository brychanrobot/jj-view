/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JjService } from '../jj-service';
import { extractRevisions, showJjError, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function duplicateCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const revision = extractRevisions(args)[0];
    if (!revision) {
        return;
    }

    try {
        await withDelayedProgress('Duplicating...', jj.duplicate(revision));
        await scmProvider.refresh({ reason: 'after duplicate' });
    } catch (e: unknown) {
        await showJjError(e, 'Error duplicating commit', jj, scmProvider.outputChannel);
    }
}
