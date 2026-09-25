/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../../../src/core/commands/command-utils';
import type { DuplicatePayload } from '../../../../src/core/commands/duplicate';

export function createDuplicatePayload(args: unknown[]): DuplicatePayload {
    const revision = extractRevision(args) || '@';
    return { revision };
}
