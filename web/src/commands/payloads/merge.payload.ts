/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevisions } from '../../../../src/core/commands/command-utils';
import type { NewMergeChangePayload } from '../../../../src/core/commands/merge';

export function createNewMergeChangePayload(args: unknown[]): NewMergeChangePayload {
    const revisions = extractRevisions(args);
    return { revisions };
}
