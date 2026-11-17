/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision, isParentResourceGroup } from '../../core/commands/command-utils';
import type { ShowDetailsPayload } from '../../core/commands/details';
import type { VsCodeScmProvider } from '../providers/vscode-scm-provider';

export function createShowDetailsPayload(args: unknown[], scmProvider?: VsCodeScmProvider): ShowDetailsPayload {
    let revision = extractRevision(args);
    if (!revision && scmProvider && isParentResourceGroup(args[0])) {
        const match = /^ancestor-(\d+)$/.exec(args[0].id);
        if (match) {
            const index = Number(match[1]);
            revision = scmProvider.scmModel.snapshot?.ancestors[index]?.entry.change_id;
        }
    }
    return { revision };
}
