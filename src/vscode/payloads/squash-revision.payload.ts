/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    extractAncestorRevision,
    extractTargetParent,
    resolveRevisionFromArgsOrScm,
} from '../../core/commands/command-utils';
import type {
    SquashRevisionIntoAncestorPayload,
    SquashRevisionIntoParentPayload,
} from '../../core/commands/squash-revision';
import type { VsCodeScmProvider } from '../providers/vscode-scm-provider';

export function createSquashRevisionIntoParentPayload(
    args: unknown[],
    scmProvider?: VsCodeScmProvider,
): SquashRevisionIntoParentPayload {
    const revision = resolveRevisionFromArgsOrScm(args, scmProvider?.scmModel.snapshot?.ancestors);
    const targetParent = extractTargetParent(args, revision);
    return { revision, targetParent };
}

export function createSquashRevisionIntoAncestorPayload(
    args: unknown[],
    scmProvider?: VsCodeScmProvider,
): SquashRevisionIntoAncestorPayload {
    const revision = resolveRevisionFromArgsOrScm(args, scmProvider?.scmModel.snapshot?.ancestors);
    const ancestorRevision = extractAncestorRevision(args, revision);
    return { revision, ancestorRevision };
}
