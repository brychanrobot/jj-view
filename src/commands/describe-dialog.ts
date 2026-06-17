/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { extractRevisions, showJjError, withDelayedProgress } from './command-utils';

export async function describeDialogCommand(scmProvider: JjScmProvider, jj: JjService, ...args: unknown[]) {
    const revision = extractRevisions(args)[0] ?? '@';

    const currentDescription = await jj.getDescription(revision);

    const input = await vscode.window.showInputBox({
        prompt: `Edit description for ${revision === '@' ? 'working copy' : revision}`,
        placeHolder: 'Description of the changes...',
        value: currentDescription,
    });

    if (input === undefined) {
        return; // User cancelled
    }

    try {
        await withDelayedProgress('Setting description...', jj.describe(input, revision));
        await scmProvider.refresh({ reason: 'after describe' });
    } catch (err: unknown) {
        await showJjError(err, 'Error setting description', jj, scmProvider.outputChannel);
    }
}
