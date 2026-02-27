/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { JjService } from '../jj-service';
import { JjScmProvider, JjResourceState } from '../jj-scm-provider';
import { collectResourceStates, showJjError } from './command-utils';

export async function moveToChildCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const resourceStates = collectResourceStates(args);

    if (resourceStates.length === 0) {
        return;
    }

    const grouped = new Map<string, string[]>();
    for (const r of resourceStates) {
        const state = r as JjResourceState;
        const rev = state.revision || '@';
        if (!grouped.has(rev)) {
            grouped.set(rev, []);
        }
        grouped.get(rev)!.push(r.resourceUri.fsPath);
    }

    for (const [revision, paths] of grouped) {
        if (revision === '@') {
            const children = await jj.getChildren('@');
            let targetChild: string | undefined;

            if (children.length === 0) {
                vscode.window.showErrorMessage('No child commits to move changes to.');
                return;
            } else if (children.length === 1) {
                targetChild = children[0];
            } else {
                targetChild = await vscode.window.showQuickPick(children, { placeHolder: 'Select child commit' });
            }

            if (targetChild) {
                await jj.moveChanges(paths, '@', targetChild);
            }
        } else if (revision === '@-') {
            await jj.moveChanges(paths, '@-', '@');
        } else {
            // Assume generic revision is a parent or ancestor we want to pull changes from into @
            await jj.moveChanges(paths, revision, '@');
        }
    }
    await scmProvider.refresh();
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
        showJjError(e, 'Failed to move changes', scmProvider.outputChannel);
    } finally {
        await scmProvider.refresh();
    }
}

