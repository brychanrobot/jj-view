/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevisions } from '../../commands/command-utils';
import type { NewPayload } from '../../commands/new';

export function createNewPayload(args: unknown[]): NewPayload {
    const revisions = extractRevisions(args);
    return {
        parents: revisions.length > 0 ? revisions : undefined,
    };
}
