/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { collectResourceStates, extractRevision, showJjError, withDelayedProgress } from './command-utils';

export async function moveToChildCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
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
            vscode.window.showErrorMessage(`No child commits to move changes to for ${revDisplay}.`);
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

        await withDelayedProgress('Moving changes...', jj.moveChanges(paths, revision, targetChild));
        await scmProvider.refresh();
    } catch (e: unknown) {
        await showJjError(e, 'Error moving changes to child', jj, scmProvider.outputChannel);
    }
}

export async function moveToParentInDiffCommand(scmProvider: JjScmProvider, jj: JjService, editor: vscode.TextEditor) {
    if (!editor) {
        return;
    }

    const docUri = editor.document.uri;
    const fsPath = docUri.fsPath;
    const relPath = path.relative(jj.workspaceRoot, fsPath);

    // Extract revision from URI query if present (for diff views)
    const query = new URLSearchParams(docUri.query);
    const revision = query.get('jj-revision') || '@';

    // Map VS Code selections to simple ranges for Service
    const ranges = editor.selections.map((s) => ({ startLine: s.start.line, endLine: s.end.line }));

    try {
        await jj.movePartialToParent(relPath, ranges, revision);
        vscode.window.showInformationMessage(`Moved changes from ${revision} to parent.`);
    } catch (e: unknown) {
        await showJjError(e, 'Failed to move changes', jj, scmProvider.outputChannel);
    } finally {
        await scmProvider.refresh();
    }
}
