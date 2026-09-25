/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevisions } from '../../../../src/core/commands/command-utils';
import type { NewPayload } from '../../../../src/core/commands/new';

export function createNewPayload(args: unknown[]): NewPayload {
    const revisions = extractRevisions(args);
    return {
        parents: revisions.length > 0 ? revisions : undefined,
    };
}
