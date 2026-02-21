/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock, asMock } from '../test-utils';
import { rebaseOntoSelectedCommand } from '../../commands/rebase';
import { JjService } from '../../jj-service';
import { JjScmProvider } from '../../jj-scm-provider';
import { TestRepo, buildGraph } from '../test-repo';
import * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        commands: { executeCommand: vi.fn() },
    });
});

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
