/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { extractRevisions, maybeFormatDescriptionOnSave, showJjError, withDelayedProgress } from './command-utils';

export async function setDescriptionCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[] = []) {
    let description = typeof args[0] === 'string' ? args[0] : undefined;
    const revisionArgs = description ? args.slice(1) : args;
    const revision =
        (description && typeof args[1] === 'string' ? args[1] : undefined) ?? extractRevisions(revisionArgs)[0] ?? '@';

    if (description === undefined) {
        if (revision === '@') {
            description = scmProvider.sourceControl.inputBox.value;
        } else {
            return false;
        }
    }
    description = description.trim();
    description = await maybeFormatDescriptionOnSave(description, scmProvider, revision);

    try {
        await withDelayedProgress('Setting description...', jj.describe(description, revision));
        await scmProvider.refresh({ reason: 'after describe' });
        return true;
    } catch (e: unknown) {
        await showJjError(e, 'Error setting description', jj, scmProvider.outputChannel);
        return false;
    }
}
