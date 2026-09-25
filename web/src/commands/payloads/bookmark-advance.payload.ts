/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AdvanceBookmarkPayload } from '../../../../src/core/commands/bookmark-advance';
import { extractRevision } from '../../../../src/core/commands/command-utils';

export function createAdvanceBookmarkPayload(args: unknown[]): AdvanceBookmarkPayload {
    const revision = extractRevision(args);
    return { revision };
}
