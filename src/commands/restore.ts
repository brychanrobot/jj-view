/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { collectResourceStates, showJjError, withDelayedProgress } from './command-utils';

export async function restoreCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const resourceStates = collectResourceStates(args);

    if (resourceStates.length === 0) {
        return;
    }

    const paths = resourceStates.map((r) => r.resourceUri.fsPath);
    try {
        await withDelayedProgress('Restoring files...', jj.restore(paths));
        await scmProvider.refresh({ reason: 'after restore' });
    } catch (e: unknown) {
        showJjError(e, 'Error restoring files', scmProvider.outputChannel);
    }
}
