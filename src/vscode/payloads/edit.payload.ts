/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../commands/command-utils';
import type { EditPayload } from '../../commands/edit';

export function createEditPayload(args: unknown[]): EditPayload {
    const revision = extractRevision(args);
    return { revision };
}
