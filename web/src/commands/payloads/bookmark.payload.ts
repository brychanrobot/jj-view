/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SetBookmarkPayload } from '../../../../src/core/commands/bookmark';
import { extractBookmarkName, extractRevisions } from '../../../../src/core/commands/command-utils';

export function createSetBookmarkPayload(args: unknown[]): SetBookmarkPayload {
    const revision = extractRevisions(args)[0];
    const name = extractBookmarkName(args);
    return { revision, name };
}
