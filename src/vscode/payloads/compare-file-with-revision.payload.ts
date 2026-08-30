/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CompareFileWithRevisionPayload } from '../../core/commands/compare-file-with-revision';
import { extractFileUriAndRevision } from './payload-helpers';

export function createCompareFileWithRevisionPayload(args: unknown[]): CompareFileWithRevisionPayload {
    return extractFileUriAndRevision(args);
}
