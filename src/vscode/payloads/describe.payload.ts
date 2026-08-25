/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevisions } from '../../commands/command-utils';
import type { SetDescriptionPayload } from '../../commands/describe';
import type { VsCodeScmProvider } from '../providers/vscode-scm-provider';

export function createSetDescriptionPayload(args: unknown[], scmProvider?: VsCodeScmProvider): SetDescriptionPayload {
    let description = typeof args[0] === 'string' ? args[0] : undefined;
    const revisionArgs = description ? args.slice(1) : args;
    const revision =
        (description && typeof args[1] === 'string' ? args[1] : undefined) ?? extractRevisions(revisionArgs)[0] ?? '@';

    if (description === undefined && revision === '@') {
        description = scmProvider?.sourceControl.inputBox.value;
    }

    return { description, revision };
}
