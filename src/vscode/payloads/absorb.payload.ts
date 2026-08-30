/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AbsorbPayload } from '../../core/commands/absorb';
import { collectResourceStates, extractRevisions } from '../../core/commands/command-utils';
import { getFsPathFromUri } from '../../core/uri-utils';

export function createAbsorbPayload(args: unknown[]): AbsorbPayload {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => getFsPathFromUri(r.resourceUri));
    const fromRevision = extractRevisions(args)[0];
    return { paths, fromRevision };
}
