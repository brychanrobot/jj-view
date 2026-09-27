/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
    SquashHunkIntoParentPayload,
    SquashSelectionIntoParentPayload,
} from '../../../../src/core/commands/squash-selection';
import type { HostEnvironment } from '../../../../src/core/host/host-environment';

export function createSquashSelectionIntoParentPayload(
    args: unknown[] = [],
    host?: HostEnvironment,
): SquashSelectionIntoParentPayload {
    const raw = args[0] as SquashSelectionIntoParentPayload | undefined;
    if (raw?.uri && raw.ranges && raw.ranges.length > 0) {
        return raw;
    }

    if (host?.documents) {
        const uri = host.documents.getActiveDocumentUri?.();
        const selections = host.documents.getActiveDocumentSelections?.();
        if (uri && selections && selections.length > 0) {
            return {
                uri,
                ranges: selections.map((s) => ({ startLine: s.startLine, endLine: s.endLine })),
            };
        }
    }

    return {};
}

export function createSquashHunkIntoParentPayload(args: unknown[] = []): SquashHunkIntoParentPayload {
    const raw = args[0] as SquashHunkIntoParentPayload | undefined;
    if (raw?.uri && raw.ranges && raw.ranges.length > 0) {
        return raw;
    }
    return {};
}
