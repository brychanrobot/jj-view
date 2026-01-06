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
import { newMergeChangeCommand } from '../../commands/merge';
import { JjService } from '../../jj-service';
import { TestRepo, buildGraph } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
    Uri: { file: (path: string) => ({ fsPath: path }) },
    window: {
        showErrorMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        showInputBox: vi.fn(),
    },
}));

describe('newMergeChangeCommand', () => {
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

    test('creates merge commit from two revisions', async () => {
        const ids = await buildGraph(repo, [
            { label: 'p1', description: 'p1' },
            { label: 'p2', description: 'p2' },
        ]);

        const args = [{ revision: ids['p1'].changeId }, { revision: ids['p2'].changeId }];
        await newMergeChangeCommand(scmProvider, jj, ...args);

        // Verify parent change IDs
        const actualParents = repo.getParents('@');
        expect(actualParents.length).toBe(2);

        expect(actualParents).toContain(ids['p1'].changeId);
        expect(actualParents).toContain(ids['p2'].changeId);
    });

    test('falls back to selection if no args', async () => {
        // Setup 2 commits
        repo.new();
        repo.describe('p1');
        const p1 = repo.getChangeId('@');

        repo.new(['root()']);
        repo.describe('p2');
        const p2 = repo.getChangeId('@');

        asMock(scmProvider.getSelectedCommitIds).mockReturnValue([p1, p2]);

        await newMergeChangeCommand(scmProvider, jj);

        expect(scmProvider.refresh).toHaveBeenCalled();

        const parents = repo.getParents('@');
        expect(parents).toContain(p1);
        expect(parents).toContain(p2);
    });

    test('ignores valid string array and shows warning', async () => {
        const args = ['rev1', 'rev2'] as unknown as { revision: string }[];

        // Mock input box to return nothing to simulate cancellation/empty input after invalid arg ignored
        asMock(vscode.window.showInputBox).mockResolvedValue(undefined);

        await newMergeChangeCommand(scmProvider, jj, ...args);

        // Should NOT create merge
        expect(scmProvider.refresh).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Need at least 1 revision to create a change.');
    });

    test('handles single parent (no merge) correctly', async () => {
        // If passed 1 revision, it should just create a new change on top (not a merge)
        repo.new();
        const c1 = repo.getChangeId('@');

        const args = [{ revision: c1 }];
        await newMergeChangeCommand(scmProvider, jj, ...args);

        expect(scmProvider.refresh).toHaveBeenCalled();

        const parents = repo.getParents('@');
        expect(parents).toContain(c1);
    });
});
