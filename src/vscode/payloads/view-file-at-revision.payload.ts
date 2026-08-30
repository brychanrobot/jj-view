/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ViewFileAtRevisionPayload } from '../../core/commands/view-file-at-revision';
import { extractFileUriAndRevision } from './payload-helpers';

export function createViewFileAtRevisionPayload(args: unknown[]): ViewFileAtRevisionPayload {
    return extractFileUriAndRevision(args);
}
