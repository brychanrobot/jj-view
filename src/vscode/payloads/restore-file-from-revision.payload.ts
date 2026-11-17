/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RestoreFileFromRevisionPayload } from '../../core/commands/restore-file-from-revision';
import { extractFileUriAndRevision } from './payload-helpers';

export function createRestoreFileFromRevisionPayload(args: unknown[]): RestoreFileFromRevisionPayload {
    return extractFileUriAndRevision(args);
}
