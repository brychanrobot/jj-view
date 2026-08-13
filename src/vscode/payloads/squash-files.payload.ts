/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    collectResourceStates,
    extractAncestorRevision,
    extractChildRevision,
    extractRevision,
} from '../../commands/command-utils';
import type {
    SquashFilesIntoAncestorPayload,
    SquashFilesIntoChildPayload,
    SquashFilesIntoParentPayload,
} from '../../commands/squash-files';
import { getFsPathFromUri } from '../../uri-utils';

export function createSquashFilesIntoParentPayload(args: unknown[]): SquashFilesIntoParentPayload {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => getFsPathFromUri(r.resourceUri));
    const revision = extractRevision(args) || '@';
    return { paths, revision };
}

export function createSquashFilesIntoAncestorPayload(args: unknown[]): SquashFilesIntoAncestorPayload {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => getFsPathFromUri(r.resourceUri));
    const revision = extractRevision(args) || '@';
    const ancestorRevision = extractAncestorRevision(args, revision);
    return { paths, revision, ancestorRevision };
}

export function createSquashFilesIntoChildPayload(args: unknown[]): SquashFilesIntoChildPayload {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => getFsPathFromUri(r.resourceUri));
    const revision = extractRevision(args) || '@';
    const childRevision = extractChildRevision(args, revision);
    return { paths, revision, childRevision };
}
