/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { collectResourceStates } from '../../commands/command-utils';
import type { OpenMergeEditorPayload } from '../../commands/merge-editor';

export function createOpenMergeEditorPayload(args: unknown[]): OpenMergeEditorPayload {
    const resourceStates = collectResourceStates(args);
    return { resourceStates };
}
