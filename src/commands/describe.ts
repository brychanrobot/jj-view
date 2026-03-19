/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JjService } from '../jj-service';
import { extractRevisions, showJjError, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function setDescriptionCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[] = []) {
    const message = typeof args[0] === 'string' ? args[0] : undefined;
    const revisionArgs = message ? args.slice(1) : args;
    const revision =
        (message && typeof args[1] === 'string' ? args[1] : undefined) ?? extractRevisions(revisionArgs)[0] ?? '@';

    const description = message ?? scmProvider.sourceControl.inputBox.value;

    if (!description) {
        return;
    }

    try {
        await withDelayedProgress('Setting description...', jj.describe(description, revision));
        await scmProvider.refresh({ reason: 'after describe' });
    } catch (e: unknown) {
        await showJjError(e, 'Error setting description', jj, scmProvider.outputChannel);
    }
}
