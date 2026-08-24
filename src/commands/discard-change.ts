/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../common/command-context';
import { getOriginalResourceUri, Uri } from '../uri-utils';

import { isLineChangeArray, type LineChange } from './command-utils';

export type { LineChange };
export { isLineChangeArray };

export interface DiscardChangePayload {
    uri?: Uri;
    changes?: unknown;
    index?: number;
}

export async function discardChangeCommand(ctx: CommandContext, payload?: DiscardChangePayload): Promise<void> {
    const uri = payload?.uri;
    const changes = payload?.changes;
    const index = payload?.index;

    if (
        !uri ||
        !changes ||
        !isLineChangeArray(changes) ||
        index === undefined ||
        index < 0 ||
        index >= changes.length
    ) {
        return;
    }

    const change = changes[index];

    try {
        const originalUri = getOriginalResourceUri(ctx.repo.rootUri.fsPath, uri);
        if (!originalUri || !Uri.isUri(originalUri)) {
            throw new Error('Could not determine original resource');
        }

        let originalTextStr = '';
        if (change.originalEndLineNumber >= change.originalStartLineNumber) {
            originalTextStr = await ctx.host.documents.readLineRangeText(
                originalUri,
                change.originalStartLineNumber,
                change.originalEndLineNumber,
            );
        }

        await ctx.host.documents.replaceLineRangeAndSave(
            uri,
            {
                startLine1Based: change.modifiedStartLineNumber,
                endLine1Based: change.modifiedEndLineNumber,
            },
            originalTextStr,
        );
    } catch (e: unknown) {
        await ctx.host.ui.showError(e, 'Failed to discard change');
    }
}
