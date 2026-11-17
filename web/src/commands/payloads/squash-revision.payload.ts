/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    extractAncestorRevision,
    extractTargetParent,
    resolveRevisionFromArgsOrScm,
} from '../../../../src/core/commands/command-utils';
import type {
    SquashRevisionIntoAncestorPayload,
    SquashRevisionIntoParentPayload,
} from '../../../../src/core/commands/squash-revision';
import type { HostEnvironment } from '../../../../src/core/host/host-environment';
import type { ScmModel } from '../../../../src/core/scm-model';

export function createSquashRevisionIntoParentPayload(
    args: unknown[],
    _hostEnvironment?: HostEnvironment,
    activeScmModel?: ScmModel,
): SquashRevisionIntoParentPayload {
    const revision = resolveRevisionFromArgsOrScm(args, activeScmModel?.snapshot?.ancestors);
    const targetParent = extractTargetParent(args, revision);
    return { revision, targetParent };
}

export function createSquashRevisionIntoAncestorPayload(
    args: unknown[],
    _hostEnvironment?: HostEnvironment,
    activeScmModel?: ScmModel,
): SquashRevisionIntoAncestorPayload {
    const revision = resolveRevisionFromArgsOrScm(args, activeScmModel?.snapshot?.ancestors);
    const ancestorRevision = extractAncestorRevision(args, revision);
    return { revision, ancestorRevision };
}
