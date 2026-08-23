/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { newMergeChangeCommand } from '../../commands/merge';
import type { JjRepository } from '../../jj-repository';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { createNewMergeChangePayload } from '../../vscode/payloads/merge.payload';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';
import { asMock } from '../vitest-utils';

describe('newMergeChangeCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

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
        ctx = new FakeCommandContext(mockJjRepo);
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

        ctx.host.ui.setNextInputBoxResponse(undefined);

        const payload = createNewMergeChangePayload(args, scmProvider);
        await newMergeChangeCommand(ctx, payload);

        expect(ctx.host.ui.errorMessages[0].prefix).toBe('Merge Error');
        expect((ctx.host.ui.errorMessages[0].error as Error).message).toContain(
            'Need at least 1 revision to create a change.',
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
