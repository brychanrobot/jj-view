/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveRevisionsWithSelection } from '../../commands/command-utils';
import type { NewAfterPayload } from '../../commands/new-after';
import type { JjScmProvider } from '../../jj-scm-provider';

export function createNewAfterPayload(args: unknown[], scmProvider?: JjScmProvider): NewAfterPayload {
    const revisions = resolveRevisionsWithSelection(args, scmProvider);
    return { revisions };
}
