/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    collectResourceStates,
    extractAncestorRevision,
    extractChildRevision,
    extractRevision,
} from '../../../../src/core/commands/command-utils';
import type {
    SquashFilesIntoAncestorPayload,
    SquashFilesIntoChildPayload,
    SquashFilesIntoParentPayload,
} from '../../../../src/core/commands/squash-files';
import type { HostEnvironment } from '../../../../src/core/host/host-environment';
import type { ScmModel } from '../../../../src/core/scm-model';
import { getFsPathFromUri } from '../../../../src/core/uri-utils';

export function createSquashFilesIntoParentPayload(
    args: unknown[],
    hostEnvironment?: HostEnvironment,
    activeScmModel?: ScmModel,
): SquashFilesIntoParentPayload {
    const platform = activeScmModel?.repo?.jj?.system?.platform ?? hostEnvironment?.system?.platform;
    const resourceStates = collectResourceStates(args, platform);
    const paths = resourceStates.map((r) => getFsPathFromUri(r.resourceUri, platform));
    const revision = extractRevision(args) || '@';
    return { paths, revision };
}

export function createSquashFilesIntoAncestorPayload(
    args: unknown[],
    hostEnvironment?: HostEnvironment,
    activeScmModel?: ScmModel,
): SquashFilesIntoAncestorPayload {
    const platform = activeScmModel?.repo?.jj?.system?.platform ?? hostEnvironment?.system?.platform;
    const resourceStates = collectResourceStates(args, platform);
    const paths = resourceStates.map((r) => getFsPathFromUri(r.resourceUri, platform));
    const revision = extractRevision(args) || '@';
    const ancestorRevision = extractAncestorRevision(args, revision);
    return { paths, revision, ancestorRevision };
}

export function createSquashFilesIntoChildPayload(
    args: unknown[],
    hostEnvironment?: HostEnvironment,
    activeScmModel?: ScmModel,
): SquashFilesIntoChildPayload {
    const platform = activeScmModel?.repo?.jj?.system?.platform ?? hostEnvironment?.system?.platform;
    const resourceStates = collectResourceStates(args, platform);
    const paths = resourceStates.map((r) => getFsPathFromUri(r.resourceUri, platform));
    const revision = extractRevision(args) || '@';
    const childRevision = extractChildRevision(args, revision);
    return { paths, revision, childRevision };
}
