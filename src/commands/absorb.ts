/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { collectResourceStates, extractRevision, withDelayedProgress } from './command-utils';

export async function absorbCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => r.resourceUri.fsPath);

    const fromRevision = extractRevision(args);

    try {
        await withDelayedProgress('Absorbing changes...', jj.absorb({ paths, fromRevision }));
        await scmProvider.refresh({ reason: 'after absorb' });
        vscode.window.setStatusBarMessage('Absorb completed.', 3000);
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Absorb failed: ${(e as Error).message}`);
    }
}
