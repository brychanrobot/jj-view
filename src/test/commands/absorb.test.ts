/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { absorbCommand } from '../../commands/absorb';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('absorbCommand', () => {
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

    it('should absorb working copy changes', async () => {
        const fileName = 'file.txt';
        await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [fileName]: 'line1\nline2\n' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { [fileName]: 'line1\nline2 modified\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await absorbCommand(ctx, {});

        expect(mockJjRepo.refresh).toHaveBeenCalledTimes(1);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after absorb' });

        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent).toBe('line1\nline2 modified\n');
    });

    it('should absorb from specific revision', async () => {
        const fileName = 'rev-absorb.txt';
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root', files: { [fileName]: 'base\n' } },
            {
                label: 'A',
                parents: ['root'],
                description: 'A',
                files: { [fileName]: 'base\nlineA\n' },
            },
            {
                label: 'B',
                parents: ['A'],
                description: 'B',
                files: { [fileName]: 'base\nlineA modified\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const commitBId = ids.B.commitId;
        await absorbCommand(ctx, { fromRevision: commitBId });

        expect(mockJjRepo.refresh).toHaveBeenCalledTimes(1);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after absorb' });

        const contentA = repo.getFileContent(ids.A.changeId, fileName);
        expect(contentA).toBe('base\nlineA modified\n');
    });
});
