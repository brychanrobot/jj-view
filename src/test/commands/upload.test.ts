/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import type { CodeForgeService } from '../../code-forge-service';
import { uploadCommand } from '../../commands/upload';
import { GitHubProvider } from '../../github-provider';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService } from '../../jj-service';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

// Mock dependencies
const mockConfig = {
    get: vi.fn(),
};

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        workspace: {
            getConfiguration: vi.fn((section) => {
                if (section === 'jj-view') {
                    return mockConfig;
                }
                return { get: vi.fn() };
            }),
        },
    });
});

describe('uploadCommand', () => {
    let jjService: JjService;
    let repo: TestRepo;
    let codeForgeService: CodeForgeService;
    let scmProvider: JjScmProvider;
    let mockOutputChannel: vscode.OutputChannel;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path);

        codeForgeService = createMock<CodeForgeService>({
            isEnabled: true,
            requestRefreshWithBackoffs: vi.fn(),
        });
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        mockOutputChannel = createMock<vscode.OutputChannel>({ appendLine: vi.fn(), show: vi.fn() });
        mockConfig.get.mockReset();
        vi.mocked(vscode.window.showErrorMessage).mockClear();
        vi.mocked(vscode.commands.executeCommand).mockClear();
    });

    afterEach(() => {
        repo.dispose();
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
        try {
            // Push first to make it tracked
            repo.gitPush('feature-x');
            repo.bookmarkMove('feature-x', ids.commitB.changeId);

            // Setup config to return 'git push' ONLY when queried for 'uploadCommand'
            mockConfig.get.mockImplementation((key: string) => {
                if (key === 'uploadCommand') {
                    return 'git push';
                }
                return undefined;
            });

            await uploadCommand(scmProvider, jjService, codeForgeService, ['feature-x'], mockOutputChannel);

            // Verify that the push succeeded and remote repository now has the ref
            expect(remoteRepo.hasGitRef('refs/heads/feature-x')).toBe(true);
            expect(scmProvider.refresh).toHaveBeenCalled();
            expect(codeForgeService.requestRefreshWithBackoffs).toHaveBeenCalled();
        } finally {
            remoteRepo.dispose();
        }
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
        try {
            // Push first to make it tracked
            repo.gitPush('feature-x');
            repo.bookmarkMove('feature-x', ids.commitB.changeId);

            mockConfig.get.mockReturnValue(undefined);

            await uploadCommand(scmProvider, jjService, codeForgeService, ['feature-x'], mockOutputChannel);

            // Verify that the default push succeeded
            expect(remoteRepo.hasGitRef('refs/heads/feature-x')).toBe(true);
            expect(scmProvider.refresh).toHaveBeenCalled();
            expect(codeForgeService.requestRefreshWithBackoffs).toHaveBeenCalled();
        } finally {
            remoteRepo.dispose();
        }
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
        try {
            // Push first to make it tracked
            repo.gitPush('feature-x');
            repo.bookmarkMove('feature-x', ids.commitB.changeId);

            mockConfig.get.mockReturnValue(undefined);

            // This simulates the webview payload: { changeId: 'feature-x' }
            await uploadCommand(
                scmProvider,
                jjService,
                codeForgeService,
                [{ changeId: 'feature-x' }],
                mockOutputChannel,
            );

            expect(remoteRepo.hasGitRef('refs/heads/feature-x')).toBe(true);
        } finally {
            remoteRepo.dispose();
        }
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

        mockConfig.get.mockReturnValue(undefined);

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

        const showErrorMessage = vscode.window.showErrorMessage as (
            message: string,
            ...items: string[]
        ) => Thenable<string | undefined>;
        vi.mocked(showErrorMessage).mockResolvedValue('Configure Upload...');

        // Capture output channel logs
        const loggedLines: string[] = [];
        mockOutputChannel.appendLine = vi.fn().mockImplementation((line: string) => {
            loggedLines.push(line);
        });

        await uploadCommand(scmProvider, jjService, badCodeForgeService, ['feature-x'], mockOutputChannel);

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
        mockConfig.get.mockImplementation((key: string) => {
            if (key === 'uploadCommand') {
                return 'git push-nonexistent';
            }
            return undefined;
        });

        const showErrorMessage = vscode.window.showErrorMessage as (
            message: string,
            ...items: string[]
        ) => Thenable<string | undefined>;
        vi.mocked(showErrorMessage).mockResolvedValue('Show Log');

        await uploadCommand(scmProvider, jjService, codeForgeService, ['feature-x'], mockOutputChannel);

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
        try {
            mockConfig.get.mockReturnValue(undefined);

            const githubProvider = new GitHubProvider(mockOutputChannel);
            const githubCodeForgeService = createMock<CodeForgeService>({
                isEnabled: true,
                requestRefreshWithBackoffs: vi.fn(),
                activeProvider: githubProvider,
            });

            // Capture output channel logs
            const loggedLines: string[] = [];
            mockOutputChannel.appendLine = vi.fn().mockImplementation((line: string) => {
                loggedLines.push(line);
            });

            await uploadCommand(
                scmProvider,
                jjService,
                githubCodeForgeService,
                [ids.commitA.changeId],
                mockOutputChannel,
            );

            // Since there was no local bookmark on commitA, the github provider's getUploadCommand should have returned git push -c <revision>
            // This should create a new bookmark starting with "push-" in the repo and push it to remote.
            const pushRefs = remoteRepo.listGitRefs('refs/heads/push-');
            expect(pushRefs.length).toBe(1);
        } finally {
            remoteRepo.dispose();
        }
    });

    test('GitHub provider: uses -r if revision has local bookmark', async () => {
        const remoteRepo = await setupRemote();
        try {
            repo.describe('root commit');
            await buildGraph(repo, [
                {
                    label: 'commitA',
                    description: 'test github push with bookmark',
                    bookmarks: ['my-feature-branch'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            mockConfig.get.mockReturnValue(undefined);

            const githubProvider = new GitHubProvider(mockOutputChannel);
            const githubCodeForgeService = createMock<CodeForgeService>({
                isEnabled: true,
                requestRefreshWithBackoffs: vi.fn(),
                activeProvider: githubProvider,
            });

            await uploadCommand(
                scmProvider,
                jjService,
                githubCodeForgeService,
                ['my-feature-branch'],
                mockOutputChannel,
            );

            // Since there was a local bookmark, it should use -r, pushing my-feature-branch.
            expect(remoteRepo.hasGitRef('refs/heads/my-feature-branch')).toBe(true);

            // Also check that no "push-" bookmark was created
            const pushRefs = remoteRepo.listGitRefs('refs/heads/push-');
            expect(pushRefs.length).toBe(0);
        } finally {
            remoteRepo.dispose();
        }
    });
});
