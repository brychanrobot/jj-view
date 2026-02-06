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
import { editCommand } from '../../commands/edit';
import { JjService } from '../../jj-service';
import { TestRepo, buildGraph } from '../test-repo';
import { JjScmProvider, JjResourceState } from '../../jj-scm-provider';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
    Uri: { file: (path: string) => ({ fsPath: path }) },
    window: {
        showErrorMessage: vi.fn(),
        withProgress: vi.fn().mockImplementation(async (_, task) => task()),
    },
    ProgressLocation: { Notification: 15 },
}));

describe('editCommand', () => {
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

    test('edits specified commit', async () => {
        // Setup: Parent -> Child. Currently at Child.
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            { label: 'child', parents: ['parent'], description: 'child', isWorkingCopy: true },
        ]);

        // Edit parent
        await editCommand(scmProvider, jj, [ids['parent'].changeId]);

        const currentChangeId = repo.getChangeId('@');
        expect(currentChangeId).toBe(ids['parent'].changeId);
    });

    test('edits from parent resource group header', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            { label: 'child', parents: ['parent'], description: 'child', isWorkingCopy: true },
        ]);

        const mockState = createMock<JjResourceState>({ revision: ids['parent'].changeId });
        const mockParentGroup = createMock<vscode.SourceControlResourceGroup>({
            id: 'parent-0',
            label: 'Parent: ...',
            resourceStates: [mockState],
        });

        await editCommand(scmProvider, jj, [mockParentGroup]);

        const currentChangeId = repo.getChangeId('@');
        expect(currentChangeId).toBe(ids['parent'].changeId);
    });
});
