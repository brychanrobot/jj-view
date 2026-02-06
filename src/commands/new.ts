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
import { extractRevision, getErrorMessage, withDelayedProgress } from './command-utils';
import { JjScmProvider } from '../jj-scm-provider';

export async function newCommand(scmProvider: JjScmProvider, jj: JjService, args?: unknown[]) {
    // args might contain a revision if triggered from context menu "New child"
    // However, usually we have separate commands or just reuse 'new'

    // Check if we have arguments passed (like from webview or context menu)
    // If we do, is it a single revision?
    let revision: string | undefined = undefined;
    if (args) {
        if (Array.isArray(args)) {
            revision = extractRevision(args);
        } else if (typeof args === 'string') {
            // direct call
            revision = args;
        }
    }

    try {
        await withDelayedProgress('Creating new change...', jj.new(undefined, revision ? [revision] : undefined));
        await scmProvider.refresh({ reason: 'after new' });
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Error creating new commit: ${getErrorMessage(e)}`);
    }
}
