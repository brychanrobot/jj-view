// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as vscode from 'vscode';
import * as path from 'path';
import { JjService } from '../jj-service';
import { JjScmProvider, JjResourceState } from '../jj-scm-provider';
import { collectResourceStates, getErrorMessage } from './command-utils';

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
    await applyMoveToParent(scmProvider, jj, editor.document, editor.selections);
}

async function applyMoveToParent(
    scmProvider: JjScmProvider,
    jj: JjService,
    document: vscode.TextDocument,
    selections: readonly vscode.Selection[],
) {
    const docUri = document.uri;
    const fsPath = docUri.fsPath;
    const relPath = path.relative(jj.workspaceRoot, fsPath);

    // Map VS Code selections to simple ranges for Service
    const ranges = selections.map((s) => ({ startLine: s.start.line, endLine: s.end.line }));

    try {
        await jj.movePartialToParent(relPath, ranges);
        vscode.window.showInformationMessage('Moved changes to parent.');
    } catch (e: unknown) {
        vscode.window.showErrorMessage('Failed to move changes: ' + getErrorMessage(e));
    } finally {
        await scmProvider.refresh();
        // Invalidate the Parent content cache so the Diff Editor updates
        if (scmProvider.contentProvider) {
            // The diff view typically uses good-juju scheme for the left side (Parent)
            const parentUri = docUri.with({ scheme: 'good-juju', query: 'revision=@-' });
            scmProvider.contentProvider.update(parentUri);
        }
    }
}

export async function moveToChildInDiffCommand(scmProvider: JjScmProvider, jj: JjService, editor: vscode.TextEditor) {
    if (!editor) {
        return;
    }
    await applyMoveToChild(scmProvider, jj, editor.document, editor.selections);
}

async function applyMoveToChild(
    scmProvider: JjScmProvider,
    jj: JjService,
    document: vscode.TextDocument,
    selections: readonly vscode.Selection[],
) {
    const docUri = document.uri;
    const fsPath = docUri.fsPath;
    const relPath = path.relative(jj.workspaceRoot, fsPath);

    const ranges = selections.map((s) => ({ startLine: s.start.line, endLine: s.end.line }));

    try {
        await jj.movePartialToChild(relPath, ranges);
        vscode.window.showInformationMessage('Moved changes to child.');
    } catch (e: unknown) {
        vscode.window.showErrorMessage('Failed to move changes: ' + getErrorMessage(e));
    } finally {
        await scmProvider.refresh();
        if (scmProvider.contentProvider) {
            const parentUri = docUri.with({ scheme: 'good-juju', query: 'revision=@-' });
            scmProvider.contentProvider.update(parentUri);
        }
    }
}
