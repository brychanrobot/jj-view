/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevisions } from '../../../../src/core/commands/command-utils';
import type { NewAfterPayload } from '../../../../src/core/commands/new-after';

export function createNewAfterPayload(args: unknown[]): NewAfterPayload {
    const revisions = extractRevisions(args);
    return { revisions: revisions.length > 0 ? revisions : ['@'] };
}
