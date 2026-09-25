/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../../../src/core/commands/command-utils';
import type { CompareAllFilesWithRevisionPayload } from '../../../../src/core/commands/compare-all-files-with-revision';

export function createCompareAllFilesWithRevisionPayload(args: unknown[]): CompareAllFilesWithRevisionPayload {
    const revision = extractRevision(args) || '@';
    return { revision };
}
