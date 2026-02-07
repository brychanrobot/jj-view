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
import * as path from 'path';
import { moveToChildCommand } from '../../commands/move';
import { JjService } from '../../jj-service';
import { TestRepo, buildGraph } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
    Uri: { file: (path: string) => ({ fsPath: path }) },
    window: {
        showQuickPick: vi.fn(),
        showErrorMessage: vi.fn(),
    },
}));

describe('moveToChildCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
        scmProvider = createMock<JjScmProvider>({ refresh: vi.fn() });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('moves file changes to child', async () => {
        const fileName = 'move.txt';
        // Parent (modified) -> Child
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [fileName]: 'modified' }, isWorkingCopy: true },
            { label: 'child', parents: ['parent'], description: 'child' },
        ]);

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri }];

        await moveToChildCommand(scmProvider, jj, args);

        const childContent = repo.getFileContent(ids['child'].changeId, fileName);
        expect(childContent).toBe('modified');
    }, 30000);
});
