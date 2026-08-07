/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { abandonDescendantsCommand } from '../../commands/abandon-descendants';
import { ScmContextValue } from '../../jj-context-keys';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';
import { asMock } from '../vitest-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: { showInputBox: vi.fn(), showWarningMessage: vi.fn() },
    });
});

describe('abandonDescendantsCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            getSelectedCommitIds: vi.fn().mockReturnValue([]),
        });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    const expectAbandoned = (changeId: string) => {
        const visibleIds = repo.getLog('all()', 'change_id');
        expect(visibleIds).not.toContain(changeId);
    };

    test('abandons revision and all its descendants', async () => {
        const graph = await buildGraph(repo, [
            { label: 'A', description: 'root' },
            { label: 'B', description: 'child A', parents: ['A'] },
            { label: 'C', description: 'child B', parents: ['B'], isCurrentWorkingCopy: true },
        ]);

        asMock(vscode.window.showWarningMessage).mockResolvedValue('Abandon');

        await abandonDescendantsCommand(scmProvider, jj, [graph.A.changeId]);

        // rev:: includes rev itself, so A, B, C are all abandoned
        expectAbandoned(graph.A.changeId);
        expectAbandoned(graph.B.changeId);
        expectAbandoned(graph.C.changeId);
    });

    test('abandons only the revision when it has no descendants', async () => {
        const graph = await buildGraph(repo, [
            { label: 'A', description: 'root' },
            { label: 'B', description: 'leaf', parents: ['A'], isCurrentWorkingCopy: true },
        ]);

        asMock(vscode.window.showWarningMessage).mockResolvedValue('Abandon');

        await abandonDescendantsCommand(scmProvider, jj, [graph.B.changeId]);

        // B has no descendants, so only B is abandoned (rev:: = just rev)
        expectAbandoned(graph.B.changeId);
        const visible = repo.getLog('all()', 'change_id');
        expect(visible).toContain(graph.A.changeId);
    });

    test('abandons working copy from resource group header', async () => {
        const graph = await buildGraph(repo, [
            { label: 'A', description: 'base' },
            { label: 'B', description: 'wc', parents: ['A'], isCurrentWorkingCopy: true },
        ]);

        asMock(vscode.window.showWarningMessage).mockResolvedValue('Abandon');

        const resourceGroup = { id: ScmContextValue.WorkingCopyGroup, label: 'Working Copy', resourceStates: [] };
        await abandonDescendantsCommand(scmProvider, jj, [resourceGroup]);

        // @ has no descendants, so only @ is abandoned
        expectAbandoned(graph.B.changeId);
        const visible = repo.getLog('all()', 'change_id');
        expect(visible).toContain(graph.A.changeId);
    });

    test('falls back to selection when no explicit arg', async () => {
        const graph = await buildGraph(repo, [
            { label: 'A', description: 'root' },
            { label: 'B', description: 'middle', parents: ['A'] },
            { label: 'C', description: 'leaf', parents: ['B'], isCurrentWorkingCopy: true },
        ]);

        asMock(scmProvider.getSelectedCommitIds).mockReturnValue([graph.A.changeId]);
        asMock(vscode.window.showWarningMessage).mockResolvedValue('Abandon');

        await abandonDescendantsCommand(scmProvider, jj, []);

        // Selected A → abandons A and all descendants (B, C)
        expectAbandoned(graph.A.changeId);
        expectAbandoned(graph.B.changeId);
        expectAbandoned(graph.C.changeId);
    });

    test('prompts for input when no args and no selection', async () => {
        const graph = await buildGraph(repo, [
            { label: 'A', description: 'root' },
            { label: 'B', description: 'leaf', parents: ['A'], isCurrentWorkingCopy: true },
        ]);

        asMock(vscode.window.showInputBox).mockResolvedValue(graph.A.changeId);
        asMock(vscode.window.showWarningMessage).mockResolvedValue('Abandon');

        await abandonDescendantsCommand(scmProvider, jj, []);

        expect(vscode.window.showInputBox).toHaveBeenCalledWith(
            expect.objectContaining({ prompt: 'Enter revision to abandon descendants of' }),
        );

        // A and B both abandoned (A:: includes A and B)
        expectAbandoned(graph.A.changeId);
        expectAbandoned(graph.B.changeId);
    });

    test('does nothing when user cancels input prompt', async () => {
        await buildGraph(repo, [{ label: 'A', isCurrentWorkingCopy: true }]);

        asMock(vscode.window.showInputBox).mockResolvedValue(undefined);

        await abandonDescendantsCommand(scmProvider, jj, []);

        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    test('does nothing when user cancels warning dialog', async () => {
        const graph = await buildGraph(repo, [
            { label: 'A', description: 'base' },
            { label: 'B', description: 'child', parents: ['A'], isCurrentWorkingCopy: true },
        ]);

        asMock(vscode.window.showWarningMessage).mockResolvedValue(undefined);

        await abandonDescendantsCommand(scmProvider, jj, [graph.A.changeId]);

        // Nothing should be abandoned
        const visible = repo.getLog('all()', 'change_id');
        expect(visible).toContain(graph.A.changeId);
        expect(visible).toContain(graph.B.changeId);
    });

    test('warning message includes descendant descriptions', async () => {
        const graph = await buildGraph(repo, [
            { label: 'A', description: 'root' },
            { label: 'B', description: 'fix login', parents: ['A'] },
            { label: 'C', description: 'add tests', parents: ['B'], isCurrentWorkingCopy: true },
        ]);

        asMock(vscode.window.showWarningMessage).mockResolvedValue('Abandon');

        await abandonDescendantsCommand(scmProvider, jj, [graph.A.changeId]);

        const call = asMock(vscode.window.showWarningMessage).mock.calls[0];
        const message = call[0] as string;
        expect(message).toContain('fix login');
        expect(message).toContain('add tests');
        expect(message).toContain('2 descendants');
    });

    test('shows warning dialog for nonexistent revision', async () => {
        await buildGraph(repo, [{ label: 'A', isCurrentWorkingCopy: true }]);

        asMock(vscode.window.showInputBox).mockResolvedValue('nonexistent');

        // getDescendants catches the error, returns [], count=0
        await abandonDescendantsCommand(scmProvider, jj, []);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('Abandon nonexistent'),
            expect.any(Object),
            'Abandon',
        );
    });
});
