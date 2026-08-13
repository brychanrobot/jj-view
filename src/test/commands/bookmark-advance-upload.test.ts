/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CodeForgeService } from '../../code-forge-service';
import { advanceBookmarkAndUploadCommand } from '../../commands/bookmark-advance-upload';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { createAdvanceBookmarkAndUploadPayload } from '../../vscode/payloads/bookmark-advance-upload.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel, FakeConfigStore } from '../test-utils';

const fakeConfigStore = new FakeConfigStore();

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        workspace: {
            getConfiguration: () => fakeConfigStore.toWorkspaceConfiguration(),
        },
    });
});

describe('advanceBookmarkAndUploadCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let remoteRepo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        remoteRepo = new TestRepo();
        remoteRepo.init();

        repo.addRemote('origin', remoteRepo.path);
        repo.config('git.push', '"origin"');

        jj = new JjService(repo.path, NO_OP_LOGGER);

        const codeForgeService = createMock<CodeForgeService>({
            isEnabled: false,
            requestRefreshWithBackoffs: vi.fn(),
        });

        mockJjRepo = createMock<JjRepository>({
            jj,
            codeForge: codeForgeService,
            refresh: vi.fn().mockResolvedValue(undefined),
        });

        ctx = new VSCodeCommandContext(mockJjRepo, createMockLogOutputChannel(), createMock<CommentsManager>({}));
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('advances bookmark and uploads to remote', async () => {
        repo.config('remotes.origin.auto-track-bookmarks', '"*"');
        repo.config('git.push-new-bookmarks', 'true');

        await jj.describe('initial');
        repo.bookmark('sync-bookmark', '@');

        await jj.new({ message: 'child' });
        const [child] = await jj.getLog({ revision: '@' });

        const payload = createAdvanceBookmarkAndUploadPayload([child.change_id]);
        await advanceBookmarkAndUploadCommand(ctx, payload);

        const [childLog] = await jj.getLog({ revision: '@' });
        expect(childLog.bookmarks).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'sync-bookmark' })]),
        );

        remoteRepo.gitImport();
        const pushedCommitId = repo.getCommitId('sync-bookmark');
        const remoteCommitId = remoteRepo.getCommitId('sync-bookmark');
        expect(remoteCommitId).toBe(pushedCommitId);
    });
});
