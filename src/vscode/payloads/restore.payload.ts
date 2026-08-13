/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { collectResourceStates } from '../../commands/command-utils';
import type { RestorePayload } from '../../commands/restore';
import { getFsPathFromUri } from '../../uri-utils';

export function createRestorePayload(args: unknown[]): RestorePayload {
    const resourceStates = collectResourceStates(args);
    const pathsByRevision: Record<string, string[]> = {};

    for (const state of resourceStates) {
        const rev = state.revision || '@';
        const list = pathsByRevision[rev] || [];
        list.push(getFsPathFromUri(state.resourceUri));
        pathsByRevision[rev] = list;
    }

    return { pathsByRevision };
}
