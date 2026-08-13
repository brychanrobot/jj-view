/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { newMergeChangeCommand } from '../../commands/merge';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import type { JjLoggerChannel } from '../../utils/output-channel';
import { createNewMergeChangePayload } from '../../vscode/payloads/merge.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';
import { asMock, resetMockQuickPick } from '../vitest-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('newMergeChangeCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;
    let mockQuickPick: vscode.QuickPick<vscode.QuickPickItem>;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({
            jj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn().mockResolvedValue(undefined),
            getSelectedCommitIds: vi.fn().mockReturnValue([]),
        });
        ctx = new VSCodeCommandContext(
            mockJjRepo,
            createMock<JjLoggerChannel>(NO_OP_LOGGER),
            createMock<CommentsManager>({}),
        );

        mockQuickPick = vi.mocked(vscode.window.createQuickPick)();
        resetMockQuickPick(mockQuickPick);
        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            acceptCallback();
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('creates merge commit from two revisions', async () => {
        const ids = await buildGraph(repo, [
            { label: 'p1', description: 'p1' },
            { label: 'p2', description: 'p2' },
        ]);

        const args = [{ revision: ids.p1.changeId }, { revision: ids.p2.changeId }];
        const payload = createNewMergeChangePayload(args, scmProvider);
        await newMergeChangeCommand(ctx, payload);

        // Verify parent change IDs
        const actualParents = repo.getParents('@');
        expect(actualParents.length).toBe(2);

        expect(actualParents).toContain(ids.p1.changeId);
        expect(actualParents).toContain(ids.p2.changeId);
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

        const payload = createNewMergeChangePayload([], scmProvider);
        await newMergeChangeCommand(ctx, payload);

        expect(mockJjRepo.refresh).toHaveBeenCalled();

        const parents = repo.getParents('@');
        expect(parents).toContain(p1);
        expect(parents).toContain(p2);
    });

    test('ignores valid string array and shows warning', async () => {
        const args = ['rev1', 'rev2'] as unknown as { revision: string }[];

        // Mock input box to return nothing to simulate cancellation/empty input after invalid arg ignored
        asMock(vscode.window.showInputBox).mockResolvedValue(undefined);

        const payload = createNewMergeChangePayload(args, scmProvider);
        await newMergeChangeCommand(ctx, payload);

        // Should NOT create merge
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Need at least 1 revision to create a change.'),
            'Show Log',
        );
    });

    test('handles single parent (no merge) correctly', async () => {
        // If passed 1 revision, it should just create a new change on top (not a merge)
        repo.new();
        const c1 = repo.getChangeId('@');

        const args = [{ revision: c1 }];
        const payload = createNewMergeChangePayload(args, scmProvider);
        await newMergeChangeCommand(ctx, payload);

        expect(mockJjRepo.refresh).toHaveBeenCalled();

        const parents = repo.getParents('@');
        expect(parents).toContain(c1);
    });
});
