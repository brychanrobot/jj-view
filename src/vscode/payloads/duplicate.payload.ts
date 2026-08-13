/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevisions } from '../../commands/command-utils';
import type { DuplicatePayload } from '../../commands/duplicate';

export function createDuplicatePayload(args: unknown[]): DuplicatePayload {
    const revision = extractRevisions(args)[0];
    return { revision };
}
