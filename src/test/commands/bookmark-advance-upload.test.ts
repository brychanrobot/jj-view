/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import type { CodeForgeService } from '../../code-forge-service';
import { advanceBookmarkAndUploadCommand } from '../../commands/bookmark-advance-upload';
import type { JjRepository } from '../../jj-repository';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
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
    let mockQuickPick: vscode.QuickPick<vscode.QuickPickItem>;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        remoteRepo = new TestRepo();
        remoteRepo.init();

        jj = new JjService(repo.path, NO_OP_LOGGER);
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            outputChannel: createMockLogOutputChannel({
                appendLine: vi.fn((msg: string) => console.log('OUTPUT CHANNEL:', msg)),
            }),
            repo: createMock<JjRepository>({
                codeForge: createMock<CodeForgeService>({
                    activeProvider: undefined,
                    requestRefreshWithBackoffs: vi.fn(),
                }),
            }),
        });

        mockQuickPick = vi.mocked(vscode.window.createQuickPick)();
        resetMockQuickPick(mockQuickPick);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('advances bookmark and uploads to remote in sequence', async () => {
        // Setup: Link local repo to remote repo
        repo.addRemote('origin', remoteRepo.path);
        repo.config('remotes.origin.auto-track-bookmarks', '"*"');
        repo.config('git.push-new-bookmarks', 'true');

        // Describe initial commit so it can be pushed
        await jj.describe('initial');

        // Create bookmark on initial commit
        repo.bookmark('sync-bookmark', '@');

        // Create child commit
        await jj.new({ message: 'child' });
        const [child] = await jj.getLog({ revision: '@' });

        // Run sequential advance and upload
        await advanceBookmarkAndUploadCommand(scmProvider, jj, [child.change_id]);

        // 1. Verify local bookmark advanced to child
        const [childLog] = await jj.getLog({ revision: '@' });
        expect(childLog.bookmarks).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'sync-bookmark' })]),
        );

        // 2. Verify remote repository received the advanced bookmark
        remoteRepo.gitImport();
        const pushedCommitId = repo.getCommitId('sync-bookmark');
        const remoteCommitId = remoteRepo.getCommitId('sync-bookmark');
        expect(remoteCommitId).toBe(pushedCommitId);

        expect(scmProvider.refresh).toHaveBeenCalled();
    });
});
