/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevisions } from '../../../../src/core/commands/command-utils';
import type { NewBeforePayload } from '../../../../src/core/commands/new-before';

export function createNewBeforePayload(args: unknown[]): NewBeforePayload {
    const revisions = extractRevisions(args);
    return { revisions: revisions.length > 0 ? revisions : ['@'] };
}
