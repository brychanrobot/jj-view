/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractAncestorRevision, extractRevision, extractTargetParent } from '../../commands/command-utils';
import type {
    SquashRevisionIntoAncestorPayload,
    SquashRevisionIntoParentPayload,
} from '../../commands/squash-revision';

export function createSquashRevisionIntoParentPayload(args: unknown[]): SquashRevisionIntoParentPayload {
    const revision = extractRevision(args) || '@';
    const targetParent = extractTargetParent(args, revision);
    return { revision, targetParent };
}

export function createSquashRevisionIntoAncestorPayload(args: unknown[]): SquashRevisionIntoAncestorPayload {
    const revision = extractRevision(args) || '@';
    const ancestorRevision = extractAncestorRevision(args, revision);
    return { revision, ancestorRevision };
}
