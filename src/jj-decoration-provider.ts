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
import { JjStatusEntry } from './jj-types';

export class JjDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private decorations = new Map<string, JjStatusEntry>();

    constructor() {}

    provideFileDecoration(
        uri: vscode.Uri,
        _token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.FileDecoration> {
        const entry = this.decorations.get(uri.toString());
        if (!entry) {
            return undefined;
        }

        const status = entry.status;
        const conflicted = entry.conflicted;

        if (conflicted) {
            return new vscode.FileDecoration(
                '!',
                'Conflicted',
                new vscode.ThemeColor('jj.conflicted'), // Or gitDecoration.conflictingResourceForeground
            );
        }

        switch (status) {
            case 'added':
                return new vscode.FileDecoration(
                    'A',
                    'Added',
                    new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
                );
            case 'modified':
                return new vscode.FileDecoration(
                    'M',
                    'Modified',
                    new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
                );
            case 'deleted':
            case 'removed':
                return new vscode.FileDecoration(
                    'D',
                    'Deleted',
                    new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
                );
            case 'renamed':
                return new vscode.FileDecoration(
                    'R',
                    'Renamed',
                    new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
                );
            case 'copied':
                return new vscode.FileDecoration(
                    'C',
                    'Copied',
                    new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
                );
            default:
                return undefined;
        }
    }

    setDecorations(decorations: Map<string, JjStatusEntry>) {
        if (this.areDecorationsEqual(this.decorations, decorations)) {
            return;
        }
        this.decorations = decorations;
        this._onDidChangeFileDecorations.fire(undefined); // Refresh all
    }

    private areDecorationsEqual(map1: Map<string, JjStatusEntry>, map2: Map<string, JjStatusEntry>): boolean {
        if (map1.size !== map2.size) {
            return false;
        }

        for (const [key, val1] of map1) {
            const val2 = map2.get(key);
            if (!val2) {
                return false;
            }
            if (val1.path !== val2.path || val1.status !== val2.status || val1.conflicted !== val2.conflicted) {
                return false;
            }
        }
        return true;
    }
    dispose() {
        this._onDidChangeFileDecorations.dispose();
    }
}
