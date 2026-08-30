/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { advanceBookmarkCommand } from './bookmark-advance';
import { uploadCommand } from './upload';

export interface AdvanceBookmarkAndUploadPayload {
    revision?: string;
}

export async function advanceBookmarkAndUploadCommand(
    ctx: CommandContext,
    payload?: AdvanceBookmarkAndUploadPayload,
): Promise<void> {
    let revision: string | undefined;
    try {
        revision = await advanceBookmarkCommand(ctx, payload);
    } catch (_e: unknown) {
        return;
    }

    if (!revision) {
        return;
    }

    await uploadCommand(ctx, { revision });
}
