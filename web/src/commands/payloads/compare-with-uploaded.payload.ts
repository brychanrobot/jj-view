/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../../../src/core/commands/command-utils';
import type { CompareWithUploadedPayload } from '../../../../src/core/commands/compare-with-uploaded';

export function createCompareWithUploadedPayload(args: unknown[]): CompareWithUploadedPayload {
    const revision = extractRevision(args) || '@';
    return { revision };
}
