/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AdvanceBookmarkPayload } from '../../commands/bookmark-advance';
import { extractRevision } from '../../commands/command-utils';

export function createAdvanceBookmarkPayload(args: unknown[]): AdvanceBookmarkPayload {
    const revision = extractRevision(args);
    return { revision };
}
