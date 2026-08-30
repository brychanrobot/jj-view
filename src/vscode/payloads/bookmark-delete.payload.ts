/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { DeleteBookmarkPayload } from '../../core/commands/bookmark-delete';
import { extractBookmarkName } from '../../core/commands/command-utils';

export function createDeleteBookmarkPayload(args: unknown[]): DeleteBookmarkPayload {
    const bookmarkName = extractBookmarkName(args);
    return { bookmarkName };
}
