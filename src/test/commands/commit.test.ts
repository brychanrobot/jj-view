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
import { commitCommand } from '../../commands/commit';
import { JjService } from '../../jj-service';
import { JjScmProvider } from '../../jj-scm-provider';
import { TestRepo } from '../test-repo';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
    window: {
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        showWarningMessage: vi.fn(),
    },
}));

describe('commitCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);

        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            sourceControl: createMock<vscode.SourceControl>({
                inputBox: createMock<vscode.SourceControlInputBox>({
                    value: '',
                }),
            }),
        });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('shows warning if input box is empty', async () => {
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = '';
        await commitCommand(scmProvider, jj);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Please provide a commit message');
        const desc = repo.getDescription('@');
        expect(desc).toBe('');
    });

    test('commits change successfully', async () => {
        repo.new(undefined, 'initial');
        const initialId = repo.getChangeId('@');

        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = 'feat: my change';
        await commitCommand(scmProvider, jj);

        const oldChangeDesc = repo.getDescription(initialId);
        expect(oldChangeDesc.trim()).toBe('feat: my change');

        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('');

        expect(scmProvider.sourceControl.inputBox.value).toBe('');
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Committed change');
        expect(scmProvider.refresh).toHaveBeenCalled();
    });
});
