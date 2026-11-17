/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { extractSelectedOrArgRevisions } from '../../core/commands/command-utils';
import type { SimplifyParentsPayload } from '../../core/commands/simplify-parents';
import type { VsCodeScmProvider } from '../providers/vscode-scm-provider';

export function createSimplifyParentsPayload(args: unknown[], scmProvider?: VsCodeScmProvider): SimplifyParentsPayload {
    const selectedRevisions = scmProvider?.getSelectedCommitIds() ?? [];
    return { revisions: extractSelectedOrArgRevisions(args, selectedRevisions) };
}
