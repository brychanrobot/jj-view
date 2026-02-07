/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { extractRevision, getErrorMessage, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function newCommand(scmProvider: JjScmProvider, jj: JjService, args?: unknown[]) {
    // args might contain a revision if triggered from context menu "New child"
    // However, usually we have separate commands or just reuse 'new'

    // Check if we have arguments passed (like from webview or context menu)
    // If we do, is it a single revision?
    let revision: string | undefined = undefined;
    if (args) {
        if (Array.isArray(args)) {
            revision = extractRevision(args);
        } else if (typeof args === 'string') {
            // direct call
            revision = args;
        }
    }

    try {
        await withDelayedProgress('Creating new change...', jj.new(undefined, revision ? [revision] : undefined));
        await scmProvider.refresh({ reason: 'after new' });
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Error creating new commit: ${getErrorMessage(e)}`);
    }
}
