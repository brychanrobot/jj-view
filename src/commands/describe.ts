/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { extractRevision, getErrorMessage, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function setDescriptionCommand(
    scmProvider: JjScmProvider,
    jj: JjService,
    description: string,
    args?: unknown[],
) {
    let revision = '@';
    if (args && Array.isArray(args)) {
        const extracted = extractRevision(args);
        if (extracted) {
            revision = extracted;
        }
    }

    try {
        await withDelayedProgress('Setting description...', jj.describe(description, revision));
        await scmProvider.refresh({ reason: 'after describe' });
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Error setting description: ${getErrorMessage(e)}`);
    }
}
