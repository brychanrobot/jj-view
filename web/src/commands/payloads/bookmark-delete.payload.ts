/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DeleteBookmarkPayload } from '../../../../src/core/commands/bookmark-delete';
import { extractBookmarkName } from '../../../../src/core/commands/command-utils';

export function createDeleteBookmarkPayload(args: unknown[]): DeleteBookmarkPayload {
    const bookmarkName = extractBookmarkName(args);
    return { bookmarkName };
}
