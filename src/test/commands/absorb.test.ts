/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { absorbCommand } from '../../commands/absorb';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import type { JjLoggerChannel } from '../../utils/output-channel';
import { createAbsorbPayload } from '../../vscode/payloads/absorb.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('absorbCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);

        mockJjRepo = createMock<JjRepository>({
            jj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });

        ctx = new VSCodeCommandContext(
            mockJjRepo,
            createMock<JjLoggerChannel>(NO_OP_LOGGER),
            createMock<CommentsManager>({}),
        );
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    const runAbsorb = async (args: unknown[]) => {
        const payload = createAbsorbPayload(args);
        await absorbCommand(ctx, payload);
    };

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

        await runAbsorb([]);

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
        const arg = { commitId: commitBId };

        await runAbsorb([arg]);

        expect(mockJjRepo.refresh).toHaveBeenCalledTimes(1);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after absorb' });

        const contentA = repo.getFileContent(ids.A.changeId, fileName);
        expect(contentA).toBe('base\nlineA modified\n');
    });
});
