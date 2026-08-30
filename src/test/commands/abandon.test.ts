/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { abandonCommand } from '../../core/commands/abandon';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('abandonCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);

        mockJjRepo = createMock<JjRepository>({
            jj,
            rootUri: Uri.file(repo.path),
            refresh: vi.fn().mockResolvedValue(undefined),
        });

        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    const expectChangeAbandoned = (changeId: string) => {
        const visibleIds = repo.getLog('all()', 'change_id');
        expect(visibleIds).not.toContain(changeId);
    };

    test('abandons specified commit', async () => {
        repo.new();
        const c1 = repo.getChangeId('@');
        repo.new();

        await abandonCommand(ctx, { revisions: [c1] });

        expectChangeAbandoned(c1);

        const parents = repo.getParents('@');
        expect(parents).not.toContain(c1);
    });

    test('abandons multiple commits', async () => {
        const graph = await buildGraph(repo, [
            { label: 'C1' },
            { label: 'C2', parents: ['C1'], isCurrentWorkingCopy: true },
        ]);
        const c1 = graph.C1.changeId;
        const c2 = graph.C2.changeId;

        await abandonCommand(ctx, { revisions: [c1, c2] });

        expectChangeAbandoned(c1);
        expectChangeAbandoned(c2);
    });

    test('prompts for input if no revisions specified', async () => {
        repo.new();
        const c1 = repo.getChangeId('@');
        repo.new();

        ctx.host.ui.setNextRevisionPromptResponse(c1);

        await abandonCommand(ctx, {});

        expectChangeAbandoned(c1);
    });

    test('abandons merge commit with multiple parents', async () => {
        const graph = await buildGraph(repo, [
            { label: 'p1', files: { 'p1.txt': 'p1' } },
            { label: 'p2', files: { 'p2.txt': 'p2' } },
            { label: 'merge', parents: ['p1', 'p2'], description: 'Merge Commit', isCurrentWorkingCopy: true },
        ]);
        const mergeChangeId = graph.merge.changeId;

        await abandonCommand(ctx, { revisions: [mergeChangeId] });

        expectChangeAbandoned(mergeChangeId);
    });
});
