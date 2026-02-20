/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JjService } from '../jj-service';
import { extractRevision, showJjError, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function newCommand(scmProvider: JjScmProvider, jj: JjService, args?: unknown[]) {
    // args might contain a revision if triggered from context menu "New child"
    // However, usually we have separate commands or just reuse 'new'

    // Check if we have arguments passed (like from webview or context menu)
    // If we do, is it a single revision?
    let parents: string[] | undefined;
    if (args) {
        if (Array.isArray(args)) {
            const revision = extractRevision(args);
            if(revision) {
                parents = [revision];
            }
        } else if (typeof args === 'string') {
            // direct call
            parents = [args];
        }
    }

    try {
        await withDelayedProgress('Creating new change...', jj.new({ parents }));
        await scmProvider.refresh({ reason: 'after new' });
    } catch (e: unknown) {
        showJjError(e, 'Error creating new commit', scmProvider.outputChannel);
    }
}
