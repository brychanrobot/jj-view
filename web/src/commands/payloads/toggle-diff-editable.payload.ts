/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { extractUriFromArgs } from '../../../../src/core/commands/command-utils';
import type { ToggleDiffEditablePayload } from '../../../../src/core/commands/toggle-diff-editable';
import type { HostEnvironment } from '../../../../src/core/host/host-environment';
import { Uri } from '../../../../src/core/uri-utils';

export function createToggleDiffEditablePayload(
    args: unknown[] = [],
    host?: HostEnvironment,
): ToggleDiffEditablePayload {
    const first = args[0];
    if (first && typeof first === 'object' && !Uri.isUri(first)) {
        const raw = first as Partial<ToggleDiffEditablePayload>;
        const leftUri = Uri.isUri(raw.leftUri) ? raw.leftUri : undefined;
        const rightUri = Uri.isUri(raw.rightUri) ? raw.rightUri : undefined;
        const resourceUri = Uri.isUri(raw.resourceUri) ? raw.resourceUri : undefined;
        const title = typeof raw.title === 'string' ? raw.title : undefined;
        if (leftUri || rightUri || resourceUri) {
            return { leftUri, rightUri, resourceUri, title };
        }
    }

    const resourceUri = extractUriFromArgs(args) ?? host?.documents.getActiveDocumentUri?.();
    return { resourceUri };
}
