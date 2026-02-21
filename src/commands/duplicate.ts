/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JjService } from '../jj-service';
import { extractRevision, showJjError, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function duplicateCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const revision = extractRevision(args);
    if (!revision) {
        return;
    }

    try {
        await withDelayedProgress('Duplicating revision...', jj.duplicate(revision));
        await scmProvider.refresh();
    } catch (e: unknown) {
        showJjError(e, 'Error duplicating commit', scmProvider.outputChannel);
    }
}
