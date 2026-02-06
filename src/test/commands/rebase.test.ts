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
import { rebaseOntoSelectedCommand } from '../../commands/rebase';
import { JjService } from '../../jj-service';
import { JjScmProvider } from '../../jj-scm-provider';
import { TestRepo, buildGraph } from '../test-repo';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
    window: {
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        withProgress: vi.fn().mockImplementation(async (_, task) => task()),
    },
    ProgressLocation: { Notification: 15 },
    commands: {
        executeCommand: vi.fn(),
    },
}));

describe('rebaseOntoSelectedCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);

        scmProvider = createMock<JjScmProvider>({
            getSelectedCommitIds: vi.fn(),
        });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('shows error if no commits selected', async () => {
        asMock(scmProvider.getSelectedCommitIds).mockReturnValue([]);
        await rebaseOntoSelectedCommand(scmProvider, jj, { commitId: 'source' });
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No commits selected to rebase onto.');
    });

    test('rebases successfully onto selected commits', async () => {
        const ids = await buildGraph(repo, [{ label: 'p1' }, { label: 'p2' }, { label: 'c1', parents: ['p1'] }]);

        const sourceId = ids['c1'].changeId;
        const destId = ids['p2'].changeId;

        asMock(scmProvider.getSelectedCommitIds).mockReturnValue([destId]);

        await rebaseOntoSelectedCommand(scmProvider, jj, { commitId: sourceId });

        expect(vscode.window.showInformationMessage).toHaveBeenCalled();
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('jj-view.refresh');

        // Verify rebase happened: c1 should now have p2 as parent
        const newParents = repo.getParents(sourceId);
        expect(newParents).toContain(destId);
    });
});
