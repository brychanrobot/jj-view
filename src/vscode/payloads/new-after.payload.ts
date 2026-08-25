/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveRevisionsWithSelection } from '../../commands/command-utils';
import type { NewAfterPayload } from '../../commands/new-after';
import type { VsCodeScmProvider } from '../providers/vscode-scm-provider';

export function createNewAfterPayload(args: unknown[], scmProvider?: VsCodeScmProvider): NewAfterPayload {
    const revisions = resolveRevisionsWithSelection(args, scmProvider);
    return { revisions };
}
