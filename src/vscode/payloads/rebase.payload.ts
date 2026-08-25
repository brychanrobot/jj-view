/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { extractRevision } from '../../commands/command-utils';
import type { RebaseOntoSelectedPayload } from '../../commands/rebase';
import type { VsCodeScmProvider } from '../providers/vscode-scm-provider';

export function createRebaseOntoSelectedPayload(
    args: unknown[],
    scmProvider?: VsCodeScmProvider,
): RebaseOntoSelectedPayload {
    const argRevision = extractRevision(args);
    const selectedIds = scmProvider?.getSelectedCommitIds() ?? [];

    if (selectedIds.length > 0) {
        const sourceId = argRevision;
        const destinations = selectedIds;
        return { sourceId, destinations };
    }

    const sourceId = argRevision;
    return { sourceId, destinations: [] };
}
