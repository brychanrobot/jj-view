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
import { getErrorMessage } from './command-utils';

export async function showCurrentChangeCommand(jj: JjService) {
    try {
        const [logEntry] = await jj.getLog({ revision: '@', useCachedSnapshot: true });
        if (logEntry) {
            vscode.window.showInformationMessage(`Current Change ID: ${logEntry.change_id}`);
        } else {
            vscode.window.showErrorMessage('No log entry found for current revision.');
        }
    } catch (err: unknown) {
        vscode.window.showErrorMessage(`Error getting jj log: ${getErrorMessage(err)}`);
    }
}
