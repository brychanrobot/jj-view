/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import type { CodeForgeAuthManager } from '../../code-forge-auth';
import type { CodeForgeService } from '../../code-forge-service';
import { uploadCommand } from '../../commands/upload';
import type { CommentsManager } from '../../comments-manager';
import { GitHubProvider } from '../../github-provider';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { createUploadPayload } from '../../vscode/payloads/upload.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { buildGraph, TestRepo } from '../test-repo';
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

describe('uploadCommand', () => {
    let jjService: JjService;
    let repo: TestRepo;
    let codeForgeService: CodeForgeService;
    let mockOutputChannel: vscode.LogOutputChannel;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path, NO_OP_LOGGER);

        codeForgeService = createMock<CodeForgeService>({
            isEnabled: true,
            requestRefreshWithBackoffs: vi.fn(),
        });
        mockJjRepo = createMock<JjRepository>({
            jj: jjService,
            codeForge: codeForgeService,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        mockOutputChannel = createMockLogOutputChannel({ appendLine: vi.fn(), show: vi.fn(), error: vi.fn() });
        ctx = new VSCodeCommandContext(mockJjRepo, mockOutputChannel, createMock<CommentsManager>({}));

        fakeConfigStore.clear();
        vi.mocked(vscode.window.showErrorMessage).mockClear();
        vi.mocked(vscode.commands.executeCommand).mockClear();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    async function setupRemote() {
        const remoteRepo = new TestRepo();
        remoteRepo.init();
        repo.addRemote('origin', remoteRepo.path);
        repo.config('remotes.origin.auto-track-bookmarks', '"*"');
        repo.config('git.push', '"origin"');
        return remoteRepo;
    }

    test('uses custom upload command when configured (correctly)', async () => {
        repo.describe('root commit');
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'test custom upload', bookmarks: ['feature-x'] },
            { label: 'commitB', parents: ['commitA'], description: 'test custom upload 2', isCurrentWorkingCopy: true },
        ]);

        const remoteRepo = await setupRemote();

        // Push first to make it tracked
        repo.gitPush('feature-x');
        repo.bookmarkMove('feature-x', ids.commitB.changeId);

        // Setup config to return 'git push' ONLY when queried for 'uploadCommand'
        fakeConfigStore.set('uploadCommand', 'git push');

        const payload = createUploadPayload(['feature-x']);
        await uploadCommand(ctx, payload);

        // Verify that the push succeeded and remote repository now has the ref
        expect(remoteRepo.hasGitRef('refs/heads/feature-x')).toBe(true);
        expect(mockJjRepo.refresh).toHaveBeenCalled();
        expect(codeForgeService.requestRefreshWithBackoffs).toHaveBeenCalled();
    });

    test('falls back to default when custom command is empty', async () => {
        repo.describe('root commit');
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'test default upload', bookmarks: ['feature-x'] },
            {
                label: 'commitB',
                parents: ['commitA'],
                description: 'test default upload 2',
                isCurrentWorkingCopy: true,
            },
        ]);

        const remoteRepo = await setupRemote();

        // Push first to make it tracked
        repo.gitPush('feature-x');
        repo.bookmarkMove('feature-x', ids.commitB.changeId);

        fakeConfigStore.clear();

        const payload = createUploadPayload(['feature-x']);
        await uploadCommand(ctx, payload);

        // Verify that the default push succeeded
        expect(remoteRepo.hasGitRef('refs/heads/feature-x')).toBe(true);
        expect(mockJjRepo.refresh).toHaveBeenCalled();
        expect(codeForgeService.requestRefreshWithBackoffs).toHaveBeenCalled();
    });

    test('extracts revision from object payload (repro for r.substring error)', async () => {
        repo.describe('root commit');
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'test object payload', bookmarks: ['feature-x'] },
            {
                label: 'commitB',
                parents: ['commitA'],
                description: 'test object payload 2',
                isCurrentWorkingCopy: true,
            },
        ]);

        const remoteRepo = await setupRemote();

        // Push first to make it tracked
        repo.gitPush('feature-x');
        repo.bookmarkMove('feature-x', ids.commitB.changeId);

        fakeConfigStore.clear();

        // This simulates the webview payload: { changeId: 'feature-x' }
        const payload = createUploadPayload([{ changeId: 'feature-x' }]);
        await uploadCommand(ctx, payload);

        expect(remoteRepo.hasGitRef('refs/heads/feature-x')).toBe(true);
    });

    test('suggests configuration when upload fails and no custom command set', async () => {
        repo.describe('root commit');
        await buildGraph(repo, [
            {
                label: 'commitA',
                description: 'test failing upload',
                bookmarks: ['feature-x'],
                isCurrentWorkingCopy: true,
            },
        ]);

        fakeConfigStore.clear();

        const badProvider = createMock<GitHubProvider>({
            getUploadCommand: () => ({
                subcommand: 'git',
                args: ['push-nonexistent'],
            }),
        });
        const badCodeForgeService = createMock<CodeForgeService>({
            isEnabled: true,
            requestRefreshWithBackoffs: vi.fn(),
            activeProvider: badProvider,
        });
        mockJjRepo = createMock<JjRepository>({
            jj: jjService,
            codeForge: badCodeForgeService,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new VSCodeCommandContext(mockJjRepo, mockOutputChannel, createMock<CommentsManager>({}));

        const showErrorMessage = vscode.window.showErrorMessage as (
            message: string,
            ...items: string[]
        ) => Thenable<string | undefined>;
        vi.mocked(showErrorMessage).mockResolvedValue('Configure Upload...');

        const payload = createUploadPayload(['feature-x']);
        await uploadCommand(ctx, payload);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Upload failed:'),
            'Show Log',
            'Configure Upload...',
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'workbench.action.openSettings',
            'jj-view.uploadCommand',
        );
    });

    test('does not suggest configuration when custom command is already set', async () => {
        repo.describe('root commit');
        await buildGraph(repo, [
            {
                label: 'commitA',
                description: 'test failed custom upload',
                bookmarks: ['feature-x'],
                isCurrentWorkingCopy: true,
            },
        ]);

        // Use an invalid custom command that will fail
        fakeConfigStore.set('uploadCommand', 'git push-nonexistent');

        const showErrorMessage = vscode.window.showErrorMessage as (
            message: string,
            ...items: string[]
        ) => Thenable<string | undefined>;
        vi.mocked(showErrorMessage).mockResolvedValue('Show Log');

        const payload = createUploadPayload(['feature-x']);
        await uploadCommand(ctx, payload);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Upload failed:'),
            'Show Log',
        );
        const calls = vi.mocked(vscode.window.showErrorMessage).mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall).not.toContain('Configure Upload...');
    });

    test('GitHub provider: uses -c if revision has no local bookmark', async () => {
        repo.describe('root commit');
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'test github push without bookmark', isCurrentWorkingCopy: true },
        ]);

        const remoteRepo = await setupRemote();

        fakeConfigStore.clear();

        const mockAuthManager = createMock<CodeForgeAuthManager>({
            registerProvider: vi.fn(),
        });
        const githubProvider = new GitHubProvider(mockAuthManager, mockOutputChannel);
        const githubCodeForgeService = createMock<CodeForgeService>({
            isEnabled: true,
            requestRefreshWithBackoffs: vi.fn(),
            activeProvider: githubProvider,
        });
        mockJjRepo = createMock<JjRepository>({
            jj: jjService,
            codeForge: githubCodeForgeService,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new VSCodeCommandContext(mockJjRepo, mockOutputChannel, createMock<CommentsManager>({}));

        const payload = createUploadPayload([ids.commitA.changeId]);
        await uploadCommand(ctx, payload);

        // Since there was no local bookmark on commitA, the github provider's getUploadCommand should have returned git push -c <revision>
        // This should create a new bookmark starting with "push-" in the repo and push it to remote.
        const pushRefs = remoteRepo.listGitRefs('refs/heads/push-');
        expect(pushRefs.length).toBe(1);
    });

    test('GitHub provider: uses -r if revision has local bookmark', async () => {
        const remoteRepo = await setupRemote();

        repo.describe('root commit');
        await buildGraph(repo, [
            {
                label: 'commitA',
                description: 'test github push with bookmark',
                bookmarks: ['my-feature-branch'],
                isCurrentWorkingCopy: true,
            },
        ]);

        fakeConfigStore.clear();

        const mockAuthManager = createMock<CodeForgeAuthManager>({
            registerProvider: vi.fn(),
        });
        const githubProvider = new GitHubProvider(mockAuthManager, mockOutputChannel);
        const githubCodeForgeService = createMock<CodeForgeService>({
            isEnabled: true,
            requestRefreshWithBackoffs: vi.fn(),
            activeProvider: githubProvider,
        });
        mockJjRepo = createMock<JjRepository>({
            jj: jjService,
            codeForge: githubCodeForgeService,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new VSCodeCommandContext(mockJjRepo, mockOutputChannel, createMock<CommentsManager>({}));

        const payload = createUploadPayload(['my-feature-branch']);
        await uploadCommand(ctx, payload);

        // Since there was a local bookmark, it should use -r, pushing my-feature-branch.
        expect(remoteRepo.hasGitRef('refs/heads/my-feature-branch')).toBe(true);

        // Also check that no "push-" bookmark was created
        const pushRefs = remoteRepo.listGitRefs('refs/heads/push-');
        expect(pushRefs.length).toBe(0);
    });
});
