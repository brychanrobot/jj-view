/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractFileUri, extractRevision } from '../../../../src/core/commands/command-utils';
import type { CompareFileWithRevisionPayload } from '../../../../src/core/commands/compare-file-with-revision';

export function createCompareFileWithRevisionPayload(args: unknown[]): CompareFileWithRevisionPayload {
    const fileUri = extractFileUri(args);
    const revision = extractRevision(args);
    return { fileUri, revision };
}
