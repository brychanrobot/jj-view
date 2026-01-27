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
import { getErrorMessage } from './command-utils';

export interface CommitMenuContext {
    commitId: string;
}

export async function rebaseOntoSelectedCommand(scmProvider: JjScmProvider, jj: JjService, arg: CommitMenuContext) {
    if (!arg || !arg.commitId) {
        return;
    }
    const sourceId = arg.commitId;

    const selectedIds = scmProvider.getSelectedCommitIds();
    if (!selectedIds || selectedIds.length === 0) {
        vscode.window.showErrorMessage('No commits selected to rebase onto.');
        return;
    }

    try {
        await jj.rebase(sourceId, selectedIds, 'source');
        vscode.window.showInformationMessage(
            `Rebasing ${sourceId.substring(0, 8)} onto ${selectedIds.length} dest(s).`,
        );
        await vscode.commands.executeCommand('jj-view.refresh');
    } catch (err: unknown) {
        vscode.window.showErrorMessage(`Error rebasing: ${getErrorMessage(err)}`);
    }
}
