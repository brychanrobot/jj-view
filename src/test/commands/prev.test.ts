/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { prevCommand } from '../../core/commands/prev';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('prevCommand', () => {
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

    test('moves working copy to a new child of the previous change by default', async () => {
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'commit A' },
            { label: 'commitB', parents: ['commitA'], description: 'commit B' },
            { label: 'wc', parents: ['commitB'], description: '', isCurrentWorkingCopy: true },
        ]);

        await prevCommand(ctx);

        expect(repo.getParents('@')).toEqual([ids.commitA.changeId]);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'prev' });
    });

    test('edits previous change directly when ui.movement.edit is true', async () => {
        repo.config('ui.movement.edit', 'true');
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'commit A' },
            { label: 'commitB', parents: ['commitA'], description: 'commit B', isCurrentWorkingCopy: true },
        ]);

        await prevCommand(ctx);

        expect(repo.getChangeId('@')).toBe(ids.commitA.changeId);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'prev' });
    });

    test('handles errors during prev and displays error message', async () => {
        // Initial working copy is directly on root(), so there is no previous ancestor behind @-
        await prevCommand(ctx);

        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Error moving to previous change');
    });
});
