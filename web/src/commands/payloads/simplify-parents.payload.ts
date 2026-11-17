/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractSelectedOrArgRevisions } from '../../../../src/core/commands/command-utils';
import type { SimplifyParentsPayload } from '../../../../src/core/commands/simplify-parents';

export function createSimplifyParentsPayload(args: unknown[], selectedCommitIds?: string[]): SimplifyParentsPayload {
    return { revisions: extractSelectedOrArgRevisions(args, selectedCommitIds) };
}
