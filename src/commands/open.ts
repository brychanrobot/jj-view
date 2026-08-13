/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import type { JjResourceState } from '../scm-resource-state';
import { toFileUri, type Uri } from '../uri-utils';

export interface OpenFilePayload {
    resourceUri?: Uri;
}

export interface OpenChangesPayload {
    resourceState?: JjResourceState;
}

// Opens the file on disk (working copy version).
// Extracts the file URI from command arguments (or active text editor),
// converts the scheme to 'file', and strips query/fragment parameters.
export async function openFileCommand(ctx: CommandContext, payload?: OpenFilePayload): Promise<void> {
    const resourceUri = payload?.resourceUri;
    if (!resourceUri) {
        return;
    }
    const uri = toFileUri(resourceUri);
    await ctx.nav.openFile(uri);
}

// Opens the diff view for the given resource state.
// Uses the pre-calculated left and right URIs stored on the JjResourceState.
export async function openChangesCommand(ctx: CommandContext, payload?: OpenChangesPayload): Promise<void> {
    const resourceState = payload?.resourceState;
    if (!resourceState?.leftUri || !resourceState?.rightUri) {
        return;
    }
    await ctx.nav.openDiff(resourceState.leftUri, resourceState.rightUri, resourceState.diffTitle ?? 'Diff');
}
