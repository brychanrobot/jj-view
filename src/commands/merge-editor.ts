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
import { JjScmProvider } from '../jj-scm-provider';
import { getErrorMessage, collectResourceStates } from './command-utils';

export async function openMergeEditorCommand(scmProvider: JjScmProvider, arg: unknown, ...rest: unknown[]) {
    // Handle both: direct object { resourceUri } from command.arguments OR array from menu context
    const resourceStates = collectResourceStates([arg, ...rest]);

    if (resourceStates.length === 0) {
        console.warn('good-juju.openMergeEditor: No valid resource states provided');
        return;
    }

    try {
        await scmProvider.openMergeEditor(resourceStates);
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Error opening merge editor: ${getErrorMessage(e)}`);
    }
}
