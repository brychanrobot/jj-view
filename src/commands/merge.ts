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
import { JjService } from '../jj-service';

import { JjScmProvider } from '../jj-scm-provider';

export interface MergeCommandArg {
    revision: string;
}

import { getErrorMessage } from './command-utils';

export async function newMergeChangeCommand(
    scmProvider: JjScmProvider,
    jj: JjService,
    ...args: (MergeCommandArg | undefined)[]
) {
    // We expect up to 2 revisions selected.
    // Logic:
    // 1. If args are passed, use them.
    // 2. If < 2 args, verify current selection in webview?
    //    Actually, commands are usually triggered from the webview context menu or palette.
    //    If palette, we might need a quickpick.

    const revisions: string[] = [];
    for (const arg of args) {
        if (arg?.revision) {
            revisions.push(arg.revision);
        }
    }

    if (revisions.length === 0) {
        // Try getting from selection
        const selection = scmProvider.getSelectedCommitIds();
        if (selection.length > 0) {
            revisions.push(...selection);
        } else {
            // Try getting from context or input
            const rev1 = await vscode.window.showInputBox({ prompt: 'Enter first revision for merge (optional)' });
            if (rev1) {
                revisions.push(rev1);
            }
            const rev2 = await vscode.window.showInputBox({ prompt: 'Enter second revision for merge (optional)' });
            if (rev2) {
                revisions.push(rev2);
            }
        }
    }

    if (revisions.length < 1) {
        vscode.window.showWarningMessage('Need at least 1 revision to create a change.');
        return;
    }

    try {
        await jj.new(undefined, revisions);
        await scmProvider.refresh();
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Failed to create merge: ${getErrorMessage(e)}`);
    }
}
