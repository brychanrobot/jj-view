/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { newMergeChangeCommand } from '../../core/commands/merge';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('newMergeChangeCommand', () => {
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
            refresh: vi.fn().mockResolvedValue(undefined),
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

        await newMergeChangeCommand(ctx, { revisions: [ids.p1.changeId, ids.p2.changeId] });

        // Verify parent change IDs
        const actualParents = repo.getParents('@');
        expect(actualParents.length).toBe(2);

        expect(actualParents).toContain(ids.p1.changeId);
        expect(actualParents).toContain(ids.p2.changeId);
    });

    test('creates commit on top of single parent', async () => {
        repo.new();
        const c1 = repo.getChangeId('@');

        await newMergeChangeCommand(ctx, { revisions: [c1] });

        expect(mockJjRepo.refresh).toHaveBeenCalled();

        const parents = repo.getParents('@');
        expect(parents).toContain(c1);
    });

    test('shows error if revisions list is empty', async () => {
        await newMergeChangeCommand(ctx, { revisions: [] });

        expect(ctx.host.ui.errorMessages[0]).toContain('Merge Error');
        expect(ctx.host.ui.errorMessages[0]).toContain('Need at least 1 revision to create a change.');
    });
});
