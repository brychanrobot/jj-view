/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractSplitFilesPayload } from '../../../../src/core/commands/command-utils';
import type { SplitFilesPayload } from '../../../../src/core/commands/split-files';
import type { HostEnvironment } from '../../../../src/core/host/host-environment';
import type { ScmModel } from '../../../../src/core/scm-model';

export function createSplitFilesPayload(
    args: unknown[],
    hostEnvironment?: HostEnvironment,
    activeScmModel?: ScmModel,
): SplitFilesPayload {
    const platform = activeScmModel?.repo?.jj?.system?.platform ?? hostEnvironment?.system?.platform;
    return extractSplitFilesPayload(args, platform);
}
