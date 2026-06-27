/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { advanceBookmarkCommand } from './bookmark-advance';
import { uploadCommand } from './upload';

export async function advanceBookmarkAndUploadCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    let revision: string | undefined;
    try {
        revision = await advanceBookmarkCommand(scmProvider, jj, args);
    } catch (_e: unknown) {
        // Errors from advanceBookmarkCommand are already handled and shown by showJjError inside it
        return;
    }

    if (!revision) {
        return; // Cancelled
    }

    // After advancing bookmarks successfully, run upload in sequence targeting the advanced revision
    await uploadCommand(scmProvider, jj, scmProvider.repo.codeForge, [revision], scmProvider.outputChannel);
}
