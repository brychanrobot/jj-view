/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { editCommand } from '../../core/commands/edit';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('editCommand', () => {
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

    test('edits specified commit', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            { label: 'child', parents: ['parent'], description: 'child', isCurrentWorkingCopy: true },
        ]);

        await editCommand(ctx, { revision: ids.parent.changeId });

        const currentChangeId = repo.getChangeId('@');
        expect(currentChangeId).toBe(ids.parent.changeId);
        expect(mockJjRepo.refresh).toHaveBeenCalled();
    });

    test('does nothing if no revision specified', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            { label: 'child', parents: ['parent'], description: 'child', isCurrentWorkingCopy: true },
        ]);

        await editCommand(ctx, {});

        const currentChangeId = repo.getChangeId('@');
        expect(currentChangeId).toBe(ids.child.changeId);
    });

    test('handles errors during edit and displays error', async () => {
        await editCommand(ctx, { revision: 'non_existent_rev_123' });

        expect(ctx.host.ui.errorMessages[0]).toContain('Error editing commit');
    });
});
