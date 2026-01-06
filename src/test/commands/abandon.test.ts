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
import { createMock, asMock } from '../test-utils';
import { abandonCommand } from '../../commands/abandon';
import { JjService } from '../../jj-service';
import { TestRepo, buildGraph } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
    Uri: { file: (path: string) => ({ fsPath: path }) },
    window: {
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        showInputBox: vi.fn(),
    },
}));

describe('abandonCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            getSelectedCommitIds: vi.fn().mockReturnValue([]),
        });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    // Helper to verify a change is truly abandoned (not just that @ moved)
    const expectChangeAbandoned = (changeId: string) => {
        const visibleIds = repo.getLogOutput('change_id');
        expect(visibleIds).not.toContain(changeId);
    };

    const expectChangeVisible = (changeId: string) => {
        const visibleIds = repo.getLogOutput('change_id');
        expect(visibleIds).toContain(changeId);
    };

    test('abandons specified commit', async () => {
        repo.describe('to abandon');
        const changeId = repo.getChangeId('@');

        await abandonCommand(scmProvider, jj, [changeId]);

        const newChangeId = repo.getChangeId('@');
        expect(newChangeId).not.toBe(changeId);
        expectChangeAbandoned(changeId);
    });

    test('abandons working copy when triggered from resource group header', async () => {
        repo.describe('working copy to abandon');
        const changeId = repo.getChangeId('@');

        // Mock a SourceControlResourceGroup
        const resourceGroup = { id: 'working-copy', label: 'Working Copy', resourceStates: [] };

        await abandonCommand(scmProvider, jj, [resourceGroup]);

        const newChangeId = repo.getChangeId('@');
        expect(newChangeId).not.toBe(changeId);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('Abandoned 1 change(s)'),
        );
    });

    test('abandons working copy and IGNORES selection when triggered from resource group header', async () => {
        repo.describe('working copy to abandon');

        // 1. Clean slate
        repo.abandon('@'); // ensure clean

        const graph = await buildGraph(repo, [
            { label: 'Keep Me', description: 'Keep Me' }, // Root commit C1
            { label: 'Abandon Me', description: 'Abandon Me', parents: ['Keep Me'], isWorkingCopy: true }, // Child commit C2 (@)
        ]);

        const keepId = graph['Keep Me'].changeId;
        const abandonId = graph['Abandon Me'].changeId;

        // Select C1 (Keep Me)
        (scmProvider.getSelectedCommitIds as unknown as { mockReturnValue: Function }).mockReturnValue([keepId]);

        const resourceGroup = { id: 'working-copy', label: 'Working Copy', resourceStates: [] };
        await abandonCommand(scmProvider, jj, [resourceGroup]);

        // Verify C2 is gone
        const currentChangeId = repo.getChangeId('@');
        expect(currentChangeId).not.toBe(abandonId);

        // Verify we are now on top of C1 (Keep Me)
        const parents = repo.getParents('@');
        expect(parents).toContain(keepId);
    });

    test('abandons clicked commit if not in selection', async () => {
        const graph = await buildGraph(repo, [{ label: 'C1' }, { label: 'C2', parents: ['C1'], isWorkingCopy: true }]);
        const c1 = graph['C1'].changeId;

        asMock(scmProvider.getSelectedCommitIds).mockReturnValue([]);

        const arg = { commitId: c1 };
        await abandonCommand(scmProvider, jj, [arg]);

        // c1 was parent of c2. If c1 is abandoned, c2 should be reparented to c1's parent (root)
        // Verify c1 is gone from parent history of c2
        const parents = repo.getParents('@'); // c2
        expect(parents).not.toContain(c1);

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('Abandoned 1 change'),
        );
    });

    test('abandons clicked commit AND selection if clicked is part of selection', async () => {
        const graph = await buildGraph(repo, [{ label: 'C1' }, { label: 'C2', parents: ['C1'], isWorkingCopy: true }]);
        const c1 = graph['C1'].changeId;
        const c2 = graph['C2'].changeId;

        (scmProvider.getSelectedCommitIds as unknown as { mockReturnValue: Function }).mockReturnValue([c1, c2]);
        const arg = { commitId: c1 };

        await abandonCommand(scmProvider, jj, [arg]);

        // Both abandoned.
        expectChangeAbandoned(c1);
        expectChangeAbandoned(c2);
    });

    test('abandons only clicked commit if clicked is NOT in selection', async () => {
        const graph = await buildGraph(repo, [{ label: 'C1' }, { label: 'C2', parents: ['C1'], isWorkingCopy: true }]);
        const c1 = graph['C1'].changeId;
        const c2 = graph['C2'].changeId;

        (scmProvider.getSelectedCommitIds as unknown as { mockReturnValue: Function }).mockReturnValue([c1]);
        const arg = { commitId: c2 };

        await abandonCommand(scmProvider, jj, [arg]);

        // c2 (the click) is abandoned. c1 (selection) is NOT abandoned.
        expectChangeAbandoned(c2);
        expectChangeVisible(c1);

        const parents = repo.getParents('@');
        expect(parents).toContain(c1);
    });

    test('falls back to selection if no click argument', async () => {
        repo.new();
        const c1 = repo.getChangeId('@');

        // Create child to be @
        repo.new();

        (scmProvider.getSelectedCommitIds as unknown as { mockReturnValue: Function }).mockReturnValue([c1]);

        await abandonCommand(scmProvider, jj, []);

        // c1 abandoned.
        expectChangeAbandoned(c1);
    });

    test('prompts for input if no selection and no click arg', async () => {
        repo.new();
        const c1 = repo.getChangeId('@');
        // Create child
        repo.new();

        asMock(vscode.window.showInputBox).mockResolvedValue(c1);

        await abandonCommand(scmProvider, jj, []);

        expect(vscode.window.showInputBox).toHaveBeenCalled();

        // c1 abandoned
        expectChangeAbandoned(c1);
    });
});
