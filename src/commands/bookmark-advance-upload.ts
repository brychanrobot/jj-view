/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import type { JjScmProvider } from '../jj-scm-provider';
import { advanceBookmarkCommand } from './bookmark-advance';
import { uploadCommand } from './upload';

export interface AdvanceBookmarkAndUploadPayload {
    revision?: string;
}

export async function advanceBookmarkAndUploadCommand(
    ctx: CommandContext,
    payload?: AdvanceBookmarkAndUploadPayload,
    scmProvider?: JjScmProvider,
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

    if (scmProvider) {
        await uploadCommand(scmProvider, ctx.repo.jj, ctx.repo.codeForge, [revision], ctx.log);
    }
}
