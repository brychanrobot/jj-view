/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveRevisionsWithSelection } from '../../commands/command-utils';
import type { NewBeforePayload } from '../../commands/new-before';
import type { JjScmProvider } from '../../jj-scm-provider';

export function createNewBeforePayload(args: unknown[], scmProvider?: JjScmProvider): NewBeforePayload {
    const revisions = resolveRevisionsWithSelection(args, scmProvider);
    return { revisions };
}
