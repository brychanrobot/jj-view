/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../commands/command-utils';
import type { ShowMultiFileDiffPayload } from '../../commands/multi-diff';

export function createShowMultiFileDiffPayload(args: unknown[]): ShowMultiFileDiffPayload {
    const revision = extractRevision(args) || '@';
    return { revision };
}
