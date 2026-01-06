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
import { extractRevision, getErrorMessage } from './command-utils';
import { JjLogWebviewProvider } from '../jj-log-webview-provider';

export async function showDetailsCommand(logWebviewProvider: JjLogWebviewProvider, args: unknown[]) {
    const revision = extractRevision(args);
    if (!revision) {
        return;
    }

    try {
        await logWebviewProvider.createCommitDetailsPanel(revision);
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Error showing details: ${getErrorMessage(e)}`);
    }
}
