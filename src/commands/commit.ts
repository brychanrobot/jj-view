/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { maybeFormatDescriptionOnSave, showJjError, withDelayedProgress } from './command-utils';

export async function commitCommand(scmProvider: JjScmProvider, jj: JjService) {
    let description = scmProvider.sourceControl.inputBox.value.trim();

    description = await maybeFormatDescriptionOnSave(description, scmProvider);

    try {
        await withDelayedProgress('Committing...', jj.commit(description));
        await scmProvider.refresh({ reason: 'after commit' });
    } catch (err: unknown) {
        await showJjError(err, 'Error committing change', jj, scmProvider.outputChannel);
    }
}
