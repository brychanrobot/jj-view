/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JjService } from '../jj-service';
import { extractRevision, showJjError, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function setDescriptionCommand(
    scmProvider: JjScmProvider,
    jj: JjService,
    args: unknown[] = [],
) {
    const message = typeof args[0] === 'string' ? args[0] : undefined;
    const revisionArgs = message ? args.slice(1) : args;
    const revision =
        (message && typeof args[1] === 'string' ? args[1] : undefined) ??
        extractRevision(revisionArgs) ??
        '@';

    const description = message ?? scmProvider.sourceControl.inputBox.value;

    if (!description) {
        return;
    }

    try {
        await withDelayedProgress('Setting description...', jj.describe(description, revision));
        await scmProvider.refresh({ reason: 'after describe' });
    } catch (e: unknown) {
        showJjError(e, 'Error setting description', scmProvider.outputChannel);
    }
}
