/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newBeforeCommand } from '../../commands/new-before';
import type { JjRepository } from '../../jj-repository';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { createNewBeforePayload } from '../../vscode/payloads/new-before.payload';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('newBeforeCommand', () => {
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

    it('should create a new commit before the target commit', async () => {
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'target', parents: ['root'], description: 'target', isCurrentWorkingCopy: true },
        ]);

        const mockScm = createMock<JjScmProvider>({
            getSelectedCommitIds: () => [],
        });

        const payload = createNewBeforePayload([{ commitId: ids.target.commitId }], mockScm);
        await newBeforeCommand(ctx, payload);

        expect(mockJjRepo.refresh).toHaveBeenCalled();
    });
});
