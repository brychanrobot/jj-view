/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AbandonPayload } from '../../core/commands/abandon';
import { extractRevisions, isCurrentWorkingCopyResourceGroup } from '../../core/commands/command-utils';
import type { VsCodeScmProvider } from '../providers/vscode-scm-provider';

export function createAbandonPayload(args: unknown[], scmProvider?: VsCodeScmProvider): AbandonPayload {
    let revisions: string[] = [];

    if (args.some((arg) => isCurrentWorkingCopyResourceGroup(arg))) {
        revisions = ['@'];
    } else {
        const argRevisions = extractRevisions(args);
        const selectedRevisions = scmProvider?.getSelectedCommitIds() ?? [];

        if (argRevisions.length > 1) {
            revisions = argRevisions;
        } else if (argRevisions.length === 1) {
            const clicked = argRevisions[0];
            if (selectedRevisions.includes(clicked)) {
                revisions = selectedRevisions;
            } else {
                revisions = [clicked];
            }
        } else if (selectedRevisions.length > 0) {
            revisions = selectedRevisions;
        }
    }

    return { revisions };
}
