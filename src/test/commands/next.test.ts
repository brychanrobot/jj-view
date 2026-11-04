/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { nextCommand } from '../../core/commands/next';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('nextCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
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

    test('moves working copy to a new child of the next change by default', async () => {
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'commit A' },
            { label: 'commitB', parents: ['commitA'], description: 'commit B' },
            { label: 'wc', parents: ['commitA'], description: '', isCurrentWorkingCopy: true },
        ]);

        await nextCommand(ctx);

        expect(repo.getParents('@')).toEqual([ids.commitB.changeId]);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'next' });
    });

    test('edits next change directly when ui.movement.edit is true', async () => {
        repo.config('ui.movement.edit', 'true');
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'commit A', isCurrentWorkingCopy: true },
            { label: 'commitB', parents: ['commitA'], description: 'commit B' },
        ]);

        await nextCommand(ctx);

        expect(repo.getChangeId('@')).toBe(ids.commitB.changeId);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'next' });
    });

    test('handles errors during next and displays error message', async () => {
        // Working copy has no child commit to advance to
        await nextCommand(ctx);

        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Error moving to next change');
    });
});
