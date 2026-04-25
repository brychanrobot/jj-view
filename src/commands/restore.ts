/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { collectResourceStates, showJjError, withDelayedProgress } from './command-utils';

export async function restoreCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const resourceStates = collectResourceStates(args);

    if (resourceStates.length === 0) {
        return;
    }

    const statesByRevision = new Map<string, string[]>();
    for (const state of resourceStates) {
        const rev = state.revision || '@';
        const list = statesByRevision.get(rev) || [];
        list.push(state.resourceUri.fsPath);
        statesByRevision.set(rev, list);
    }

    try {
        for (const [rev, paths] of statesByRevision.entries()) {
            if (rev === '@') {
                await withDelayedProgress('Restoring files...', jj.restore(paths));
            } else {
                await withDelayedProgress(`Restoring files for ${rev}...`, jj.restore(paths, { changesIn: rev }));
            }
        }
        await scmProvider.refresh({ reason: 'after restore' });
    } catch (e: unknown) {
        await showJjError(e, 'Error restoring files', jj, scmProvider.outputChannel);
    }
}
