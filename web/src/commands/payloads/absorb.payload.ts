/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AbsorbPayload } from '../../../../src/core/commands/absorb';
import { collectResourceStates, extractRevisions } from '../../../../src/core/commands/command-utils';
import type { HostEnvironment } from '../../../../src/core/host/host-environment';
import type { ScmModel } from '../../../../src/core/scm-model';
import { getFsPathFromUri } from '../../../../src/core/uri-utils';

export function createAbsorbPayload(
    args: unknown[],
    hostEnvironment?: HostEnvironment,
    activeScmModel?: ScmModel,
): AbsorbPayload {
    const platform = activeScmModel?.repo?.jj?.system?.platform ?? hostEnvironment?.system?.platform;
    const resourceStates = collectResourceStates(args, platform);
    const paths = resourceStates.map((r) => getFsPathFromUri(r.resourceUri, platform));
    const fromRevision = extractRevisions(args)[0];
    return { paths, fromRevision };
}
