/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractFileUri, extractRevision } from '../../../../src/core/commands/command-utils';
import type { RestoreFileFromRevisionPayload } from '../../../../src/core/commands/restore-file-from-revision';
import type { HostEnvironment } from '../../../../src/core/host/host-environment';

export function createRestoreFileFromRevisionPayload(
    args: unknown[] = [],
    host?: HostEnvironment,
): RestoreFileFromRevisionPayload {
    const fileUri = extractFileUri(args) ?? host?.documents.getActiveDocumentUri?.();
    const revision = extractRevision(args);
    return { fileUri, revision };
}
