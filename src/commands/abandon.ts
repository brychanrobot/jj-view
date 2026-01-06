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
import { extractRevision, isWorkingCopyResourceGroup } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function abandonCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    let revisions: string[] = [];

    // 1. Check if triggered from Working Copy header (ignore selection)
    if (args.some(isWorkingCopyResourceGroup)) {
        revisions = ['@'];
    } else {
        // 2. Check explicit argument (e.g. context menu click)
        const clickedRevision = extractRevision(args);

        // 3. Check selection
        const selectedRevisions = scmProvider.getSelectedCommitIds();

        if (clickedRevision) {
            if (selectedRevisions.includes(clickedRevision)) {
                // Clicked on a selection -> abandon all selected
                revisions = selectedRevisions;
            } else {
                // Clicked outside selection -> abandon only the clicked one
                revisions = [clickedRevision];
            }
        } else {
            // No click arg -> use selection or prompt
            if (selectedRevisions.length > 0) {
                revisions = selectedRevisions;
            } else {
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter revision to abandon',
                    placeHolder: 'Revision ID (e.g. @, commit_id)',
                });
                if (input) {
                    revisions = [input];
                }
            }
        }
    }

    if (revisions.length === 0) {
        return;
    }

    try {
        await jj.abandon(revisions);
        await scmProvider.refresh();
        vscode.window.showInformationMessage(`Abandoned ${revisions.length} change(s).`);
    } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Error abandoning commit: ${errorMessage}`);
    }
}
