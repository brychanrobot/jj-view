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

vi.mock('vscode', () => ({
    commands: {
        executeCommand: vi.fn(),
    },
    Uri: {
        file: (path: string) => ({ fsPath: path, path: path, scheme: 'file' }),
        parse: (path: string) => ({ fsPath: path, path: path, scheme: 'file' }),
    },
}));

describe('openFileCommand', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    test('does nothing if no resource state', async () => {
        await openFileCommand(undefined);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('executes vscode.open with resource uri', async () => {
        const resourceState = createMock<vscode.SourceControlResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
        });

        await openFileCommand(resourceState);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.open', resourceState.resourceUri);
    });
});
