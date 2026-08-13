/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { DeleteBookmarkPayload } from '../../commands/bookmark-delete';
import { extractBookmarkName } from '../../commands/command-utils';

export function createDeleteBookmarkPayload(args: unknown[]): DeleteBookmarkPayload {
    const bookmarkName = extractBookmarkName(args);
    return { bookmarkName };
}
