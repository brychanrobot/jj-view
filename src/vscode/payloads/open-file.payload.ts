/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OpenFilePayload } from '../../core/commands/open';
import { extractActiveResourceUri } from './payload-helpers';

export function createOpenFilePayload(args: unknown[]): OpenFilePayload {
    return extractActiveResourceUri(args);
}
