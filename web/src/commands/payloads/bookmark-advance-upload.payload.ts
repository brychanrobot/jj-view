/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AdvanceBookmarkAndUploadPayload } from '../../../../src/core/commands/bookmark-advance-upload';
import { extractRevision } from '../../../../src/core/commands/command-utils';

export function createAdvanceBookmarkAndUploadPayload(args: unknown[]): AdvanceBookmarkAndUploadPayload {
    const revision = extractRevision(args);
    return { revision };
}
