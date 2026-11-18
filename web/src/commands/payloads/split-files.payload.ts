/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractSplitFilesPayload } from '../../../../src/core/commands/command-utils';
import type { SplitFilesPayload } from '../../../../src/core/commands/split-files';

export function createSplitFilesPayload(args: unknown[]): SplitFilesPayload {
    return extractSplitFilesPayload(args);
}
