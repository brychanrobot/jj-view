/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';

import { showJjError, withDelayedProgress } from './command-utils';

export async function undoCommand(scmProvider: JjScmProvider, jj: JjService) {
    try {
        await withDelayedProgress('Undoing...', jj.undo());
        await scmProvider.refresh();
    } catch (e: unknown) {
        showJjError(e, 'Error undoing', scmProvider.outputChannel);
    }
}
