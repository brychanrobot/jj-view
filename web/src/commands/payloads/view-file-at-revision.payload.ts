/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractFileUri, extractRevision } from '../../../../src/core/commands/command-utils';
import type { ViewFileAtRevisionPayload } from '../../../../src/core/commands/view-file-at-revision';

export function createViewFileAtRevisionPayload(args: unknown[]): ViewFileAtRevisionPayload {
    const fileUri = extractFileUri(args);
    const revision = extractRevision(args);
    return { fileUri, revision };
}
