/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AbandonPayload } from '../../../../src/core/commands/abandon';
import { extractRevisions, isCurrentWorkingCopyResourceGroup } from '../../../../src/core/commands/command-utils';

export function createAbandonPayload(args: unknown[], selectedCommitIds?: string[]): AbandonPayload {
    let revisions: string[] = [];

    if (args.some((arg) => isCurrentWorkingCopyResourceGroup(arg))) {
        revisions = ['@'];
    } else {
        const argRevisions = extractRevisions(args);
        if (argRevisions.length > 1) {
            revisions = argRevisions;
        } else if (argRevisions.length === 1) {
            const clicked = argRevisions[0];
            if (selectedCommitIds?.includes(clicked)) {
                revisions = selectedCommitIds;
            } else {
                revisions = [clicked];
            }
        } else if (selectedCommitIds && selectedCommitIds.length > 0) {
            revisions = selectedCommitIds;
        } else {
            revisions = ['@'];
        }
    }

    return { revisions };
}
