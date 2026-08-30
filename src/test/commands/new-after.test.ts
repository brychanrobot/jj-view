/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newAfterCommand } from '../../core/commands/new-after';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('newAfterCommand', () => {
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

    it('should create a new commit after the target commit', async () => {
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'target', parents: ['root'], description: 'target', isCurrentWorkingCopy: true },
        ]);

        await newAfterCommand(ctx, { revisions: [ids.target.commitId] });

        expect(mockJjRepo.refresh).toHaveBeenCalled();
    });
});
