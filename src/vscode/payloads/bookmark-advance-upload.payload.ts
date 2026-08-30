/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AdvanceBookmarkAndUploadPayload } from '../../core/commands/bookmark-advance-upload';
import { extractRevision } from '../../core/commands/command-utils';

export function createAdvanceBookmarkAndUploadPayload(args: unknown[]): AdvanceBookmarkAndUploadPayload {
    const revision = extractRevision(args);
    return { revision };
}
