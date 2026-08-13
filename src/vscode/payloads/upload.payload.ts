/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../commands/command-utils';
import type { UploadPayload } from '../../commands/upload';

export function createUploadPayload(args: unknown[]): UploadPayload {
    const revision = extractRevision(args);
    return { revision };
}
