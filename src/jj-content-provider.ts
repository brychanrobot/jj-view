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
import { JjService } from './jj-service';

export class JjDocumentContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    get onDidChange(): vscode.Event<vscode.Uri> {
        return this._onDidChange.event;
    }

    constructor(private jj: JjService) {}

    update(uri: vscode.Uri) {
        this._onDidChange.fire(uri);
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        // expected uri format: jj-view:/absolute/path/to/file?revision=xyz
        // OR jj-view:/absolute/path/to/file (defaults to parent of working copy)

        const query = new URLSearchParams(uri.query);
        const revision = query.get('revision') || '@-';

        try {
            return await this.jj.cat(uri.fsPath, revision);
        } catch (e) {
            return ''; // Return empty if file not found (e.g. added file)
        }
    }
}
