/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { collectResourceStates, extractRevision, showJjError, withDelayedProgress } from './command-utils';

/**
 * Command to squash (move) whole file changes from a revision to one of its children.
 */
export async function squashFileToChildCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => r.resourceUri.fsPath);

    if (paths.length === 0) {
        return;
    }

    const revision = extractRevision(args) || '@';

    try {
        const children = await jj.getChildren(revision);
        let targetChild: string | undefined;

        if (children.length === 0) {
            const revDisplay = revision === '@' ? 'the working copy' : revision;
            vscode.window.showErrorMessage(`No child commits to squash changes to for ${revDisplay}.`);
            return;
        } else if (children.length === 1) {
            targetChild = children[0];
        } else {
            targetChild = await vscode.window.showQuickPick(children, {
                placeHolder: `Select child commit for ${revision}`,
            });
        }

        if (!targetChild) {
            return;
        }

        await withDelayedProgress('Squashing changes to child...', jj.squashFiles(paths, revision, targetChild));
        await scmProvider.refresh();
    } catch (e: unknown) {
        await showJjError(e, 'Error squashing changes to child', jj, scmProvider.outputChannel);
    }
}
