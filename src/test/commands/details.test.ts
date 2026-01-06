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

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import { showDetailsCommand } from '../../commands/details';
import { JjLogWebviewProvider } from '../../jj-log-webview-provider';
import { JjResourceState } from '../../jj-scm-provider';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
    Uri: { file: (path: string) => ({ fsPath: path }) },
    window: { showErrorMessage: vi.fn() },
}));

describe('showDetailsCommand', () => {
    let mockProvider: JjLogWebviewProvider;

    beforeEach(() => {
        mockProvider = createMock<JjLogWebviewProvider>({
            createCommitDetailsPanel: vi.fn(),
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('calls createCommitDetailsPanel with revision string', async () => {
        await showDetailsCommand(mockProvider, ['somerev']);
        expect(mockProvider.createCommitDetailsPanel).toHaveBeenCalledWith('somerev');
    });

    test('calls createCommitDetailsPanel with resource group', async () => {
        const mockState = createMock<JjResourceState>({ revision: 'somerev' });
        const mockGroup = createMock<vscode.SourceControlResourceGroup>({
            id: 'parent-0',
            label: 'Parent',
            resourceStates: [mockState],
        });
        await showDetailsCommand(mockProvider, [mockGroup]);
        expect(mockProvider.createCommitDetailsPanel).toHaveBeenCalledWith('somerev');
    });

    test('does nothing if no revision extracted', async () => {
        await showDetailsCommand(mockProvider, [{}]);
        expect(mockProvider.createCommitDetailsPanel).not.toHaveBeenCalled();
    });
});
