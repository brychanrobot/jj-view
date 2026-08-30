/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../core/commands/command-utils';
import type { ShowDetailsPayload } from '../../core/commands/details';

export function createShowDetailsPayload(args: unknown[]): ShowDetailsPayload {
    const revision = extractRevision(args) || '@';
    return { revision };
}
