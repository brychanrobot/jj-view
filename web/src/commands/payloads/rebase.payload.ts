/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../../../src/core/commands/command-utils';
import type { RebaseOntoSelectedPayload } from '../../../../src/core/commands/rebase';

export function createRebaseOntoSelectedPayload(args: unknown[], selectedIds?: string[]): RebaseOntoSelectedPayload {
    const argRevision = extractRevision(args);
    const selected = selectedIds ?? [];

    if (selected.length > 0) {
        const sourceId = argRevision;
        const destinations = selected;
        return { sourceId, destinations };
    }

    const sourceId = argRevision;
    return { sourceId, destinations: [] };
}
