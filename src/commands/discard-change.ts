/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../common/command-context';
import { getOriginalResourceUri, Uri } from '../uri-utils';

export interface LineChange {
    readonly originalStartLineNumber: number;
    readonly originalEndLineNumber: number;
    readonly modifiedStartLineNumber: number;
    readonly modifiedEndLineNumber: number;
}

export function isLineChangeArray(changes: unknown): changes is LineChange[] {
    if (!Array.isArray(changes)) {
        return false;
    }
    return changes.every((c) => {
        const change = c as LineChange;
        return (
            typeof change.originalStartLineNumber === 'number' &&
            typeof change.originalEndLineNumber === 'number' &&
            typeof change.modifiedStartLineNumber === 'number' &&
            typeof change.modifiedEndLineNumber === 'number'
        );
    });
}

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
            originalTextStr = await ctx.documents.readLineRangeText(
                originalUri,
                change.originalStartLineNumber,
                change.originalEndLineNumber,
            );
        }

        await ctx.documents.replaceLineRangeAndSave(
            uri,
            {
                startLine1Based: change.modifiedStartLineNumber,
                endLine1Based: change.modifiedEndLineNumber,
            },
            originalTextStr,
        );
    } catch (e: unknown) {
        await ctx.ui.showError(e, 'Failed to discard change');
    }
}
