/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { OpenChangesPayload } from '../../core/commands/open';
import type { JjResourceState } from '../../core/scm-resource-state';

export function createOpenChangesPayload(args: unknown[]): OpenChangesPayload {
    const resourceState = args[0] as JjResourceState | undefined;
    return { resourceState };
}
