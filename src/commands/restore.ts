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
import { collectResourceStates, getErrorMessage, withDelayedProgress } from './command-utils';

export async function restoreCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const resourceStates = collectResourceStates(args);

    if (resourceStates.length === 0) {
        return;
    }

    const paths = resourceStates.map((r) => r.resourceUri.fsPath);
    try {
        await withDelayedProgress('Restoring files...', jj.restore(paths));
        await scmProvider.refresh({ reason: 'after restore' });
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Error restoring files: ${getErrorMessage(e)}`);
    }
}
