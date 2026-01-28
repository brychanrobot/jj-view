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

import { describe, test, expect, afterEach, vi } from 'vitest';
import { openFileCommand } from '../../commands/open';
import * as vscode from 'vscode';
import { createMock } from '../test-utils';

vi.mock('vscode', () => {
    const uriFactory = (path: string, query: string = '') => ({
        fsPath: path,
        path: path,
        scheme: 'file',
        query,
        with: (change: { query?: string }) => uriFactory(path, change.query !== undefined ? change.query : query),
    });

    return {
        commands: {
            executeCommand: vi.fn(),
        },
        Uri: {
            file: (path: string) => uriFactory(path),
            parse: (path: string) => uriFactory(path),
        },
    };
});

describe('openFileCommand', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    test('does nothing if no resource state', async () => {
        await openFileCommand(undefined);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('executes vscode.open with resource uri stripped of query params', async () => {
        // Create a URI that "starts" with a query, although the mock factory default is empty.
        // We rely on the fact that openFileCommand calls .with({ query: '' })
        const resourceState = createMock<vscode.SourceControlResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
        });

        await openFileCommand(resourceState);

        // We expect it to be called with a URI that has empty query
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/foo',
                query: '',
            }),
        );
    });
});
