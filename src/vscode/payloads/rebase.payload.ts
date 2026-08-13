/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { RebaseOntoSelectedPayload } from '../../commands/rebase';
import type { JjScmProvider } from '../../jj-scm-provider';

export function createRebaseOntoSelectedPayload(
    args: unknown[],
    scmProvider?: JjScmProvider,
): RebaseOntoSelectedPayload {
    const arg = args[0] as { commitId?: string } | undefined;
    const sourceId = arg?.commitId;
    const destinations = scmProvider?.getSelectedCommitIds() ?? [];
    return { sourceId, destinations };
}
