/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { collectResourceStates } from '../../../../src/core/commands/command-utils';
import type { RestorePayload } from '../../../../src/core/commands/restore';
import type { HostEnvironment } from '../../../../src/core/host/host-environment';
import type { ScmModel } from '../../../../src/core/scm-model';
import { getFsPathFromUri } from '../../../../src/core/uri-utils';

export function createRestorePayload(
    args: unknown[],
    hostEnvironment?: HostEnvironment,
    activeScmModel?: ScmModel,
): RestorePayload {
    const platform = activeScmModel?.repo?.jj?.system?.platform ?? hostEnvironment?.system?.platform;
    const resourceStates = collectResourceStates(args, platform);
    const pathsByRevision: Record<string, string[]> = {};

    for (const state of resourceStates) {
        const isWc = !state.revision || state.revision === '@' || state.resourceUri.scheme === 'file';
        const rev = isWc ? '@' : state.revision;
        const list = pathsByRevision[rev] || [];
        list.push(getFsPathFromUri(state.resourceUri, platform));
        pathsByRevision[rev] = list;
    }

    return { pathsByRevision };
}
