/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rebaseOntoSelectedCommand } from '../../commands/rebase';
import type { JjRepository } from '../../jj-repository';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { createRebaseOntoSelectedPayload } from '../../vscode/payloads/rebase.payload';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('rebaseOntoSelectedCommand', () => {
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

    it('should rebase source commit onto selected destinations', async () => {
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'dest', parents: ['root'], description: 'dest' },
            { label: 'source', parents: ['root'], description: 'source', isCurrentWorkingCopy: true },
        ]);

        const mockScm = createMock<JjScmProvider>({
            getSelectedCommitIds: () => [ids.dest.commitId],
        });

        const payload = createRebaseOntoSelectedPayload([{ commitId: ids.source.commitId }], mockScm);
        await rebaseOntoSelectedCommand(ctx, payload);

        expect(mockJjRepo.refresh).toHaveBeenCalled();
    });
});
