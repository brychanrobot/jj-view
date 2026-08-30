/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { redoCommand } from '../../core/commands/redo';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('redoCommand', () => {
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

    test('reapplies previously undone action', async () => {
        repo.new(['@'], 'step 1');
        const changeId = repo.getChangeId('@');

        await jj.undo();
        expect(repo.getChangeId('@')).not.toBe(changeId);

        await redoCommand(ctx);

        expect(repo.getChangeId('@')).toBe(changeId);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'redo' });
    });

    test('handles errors during redo and displays error', async () => {
        await redoCommand(ctx);

        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Error redoing');
    });
});
