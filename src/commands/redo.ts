/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import { showJjError, withDelayedProgress } from './command-utils';

export async function redoCommand(scmProvider: JjScmProvider, jj: JjService) {
    try {
        await withDelayedProgress('Redoing...', jj.redo());
        await scmProvider.refresh();
    } catch (e: unknown) {
        await showJjError(e, 'Error redoing', jj, scmProvider.outputChannel);
    }
}
