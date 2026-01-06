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
import { showCurrentChangeCommand } from '../../commands/show';
import { JjService } from '../../jj-service';
import { TestRepo } from '../test-repo';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
    window: {
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
    },
}));

describe('showCurrentChangeCommand', () => {
    let repo: TestRepo;
    let jj: JjService;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('shows information message with change id', async () => {
        const currentId = repo.getChangeId('@').trim();

        await showCurrentChangeCommand(jj);

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(`Current Change ID: ${currentId}`);
    });
});
