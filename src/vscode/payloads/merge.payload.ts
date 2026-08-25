/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { MergeCommandArg, NewMergeChangePayload } from '../../commands/merge';
import type { VsCodeScmProvider } from '../providers/vscode-scm-provider';

export function createNewMergeChangePayload(args: unknown[], scmProvider?: VsCodeScmProvider): NewMergeChangePayload {
    const revisions: string[] = [];
    for (const arg of args) {
        const mergeArg = arg as MergeCommandArg | undefined;
        if (mergeArg?.revision) {
            revisions.push(mergeArg.revision);
        }
    }

    if (revisions.length === 0 && scmProvider) {
        const selection = scmProvider.getSelectedCommitIds();
        if (selection.length > 0) {
            revisions.push(...selection);
        }
    }

    return { revisions };
}
