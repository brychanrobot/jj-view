/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import type { CodeForgeService } from '../../code-forge-service';
import { advanceBookmarkAndUploadCommand } from '../../commands/bookmark-advance-upload';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import type { JjLoggerChannel } from '../../utils/output-channel';
import { createAdvanceBookmarkAndUploadPayload } from '../../vscode/payloads/bookmark-advance-upload.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';
import { resetMockQuickPick } from '../vitest-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('advanceBookmarkAndUploadCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let remoteRepo: TestRepo;
    let scmProvider: JjScmProvider;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;
    let mockQuickPick: vscode.QuickPick<vscode.QuickPickItem>;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        remoteRepo = new TestRepo();
        remoteRepo.init();

        jj = new JjService(repo.path, NO_OP_LOGGER);
        const codeForge = createMock<CodeForgeService>({
            activeProvider: undefined,
            requestRefreshWithBackoffs: vi.fn(),
        });
        mockJjRepo = createMock<JjRepository>({
            jj,
            codeForge,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            outputChannel: createMockLogOutputChannel({
                appendLine: vi.fn(),
            }),
            repo: mockJjRepo,
        });
        ctx = new VSCodeCommandContext(
            mockJjRepo,
            createMock<JjLoggerChannel>(NO_OP_LOGGER),
            createMock<CommentsManager>({}),
        );

        mockQuickPick = vi.mocked(vscode.window.createQuickPick)();
        resetMockQuickPick(mockQuickPick);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('advances bookmark and uploads to remote in sequence', async () => {
        repo.addRemote('origin', remoteRepo.path);
        repo.config('remotes.origin.auto-track-bookmarks', '"*"');
        repo.config('git.push-new-bookmarks', 'true');

        await jj.describe('initial');
        repo.bookmark('sync-bookmark', '@');

        await jj.new({ message: 'child' });
        const [child] = await jj.getLog({ revision: '@' });

        const payload = createAdvanceBookmarkAndUploadPayload([child.change_id]);
        await advanceBookmarkAndUploadCommand(ctx, payload, scmProvider);

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
