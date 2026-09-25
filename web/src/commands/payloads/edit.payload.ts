/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../../../src/core/commands/command-utils';
import type { EditPayload } from '../../../../src/core/commands/edit';

export function createEditPayload(args: unknown[]): EditPayload {
    const revision = extractRevision(args) || '@';
    return { revision };
}
