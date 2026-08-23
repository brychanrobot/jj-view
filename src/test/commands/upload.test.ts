/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CodeForgeProvider } from '../../code-forge-provider';
import type { CodeForgeService } from '../../code-forge-service';
import { uploadCommand } from '../../commands/upload';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('uploadCommand', () => {
    let jjService: JjService;
    let repo: TestRepo;
    let codeForgeService: CodeForgeService;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

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
        ctx = new FakeCommandContext(mockJjRepo);
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
        ctx.host.config.set('uploadCommand', 'git push');

        await uploadCommand(ctx, { revision: 'feature-x' });

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

        await uploadCommand(ctx, { revision: 'feature-x' });

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

        await uploadCommand(ctx, { revision: 'feature-x' });

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

        const badProvider = createMock<CodeForgeProvider>({
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
        ctx = new FakeCommandContext(mockJjRepo);

        ctx.host.ui.setNextErrorResponse('Configure Upload...');

        await uploadCommand(ctx, { revision: 'feature-x' });

        expect(ctx.host.ui.errorMessages[0].prefix).toContain('Upload failed');
        expect(ctx.host.nav.settingsOpened).toContain('jj-view.uploadCommand');
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
        ctx.host.config.set('uploadCommand', 'git push-nonexistent');

        ctx.host.ui.setNextErrorResponse('Show Log');

        await uploadCommand(ctx, { revision: 'feature-x' });

        expect(ctx.host.ui.errorMessages[0].prefix).toContain('Upload failed');
        expect(ctx.host.nav.settingsOpened).toHaveLength(0);
    });

    test('GitHub provider: uses -c if revision has no local bookmark', async () => {
        repo.describe('root commit');
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'test github push without bookmark', isCurrentWorkingCopy: true },
        ]);

        const remoteRepo = await setupRemote();

        const mockProvider = createMock<CodeForgeProvider>({
            getUploadCommand: (rev: string, hasBookmark?: boolean) => {
                const args = ['push'];
                if (!hasBookmark) {
                    args.push('-c', rev);
                } else {
                    args.push('-r', rev);
                }
                return { subcommand: 'git', args };
            },
        });
        const githubCodeForgeService = createMock<CodeForgeService>({
            isEnabled: true,
            requestRefreshWithBackoffs: vi.fn(),
            activeProvider: mockProvider,
        });
        mockJjRepo = createMock<JjRepository>({
            jj: jjService,
            codeForge: githubCodeForgeService,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new FakeCommandContext(mockJjRepo);

        await uploadCommand(ctx, { revision: ids.commitA.changeId });

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

        const mockProvider = createMock<CodeForgeProvider>({
            getUploadCommand: (rev: string, hasBookmark?: boolean) => {
                const args = ['push'];
                if (!hasBookmark) {
                    args.push('-c', rev);
                } else {
                    args.push('-r', rev);
                }
                return { subcommand: 'git', args };
            },
        });
        const githubCodeForgeService = createMock<CodeForgeService>({
            isEnabled: true,
            requestRefreshWithBackoffs: vi.fn(),
            activeProvider: mockProvider,
        });
        mockJjRepo = createMock<JjRepository>({
            jj: jjService,
            codeForge: githubCodeForgeService,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new FakeCommandContext(mockJjRepo);

        await uploadCommand(ctx, { revision: 'my-feature-branch' });

        // Since there was a local bookmark, it should use -r, pushing my-feature-branch.
        expect(remoteRepo.hasGitRef('refs/heads/my-feature-branch')).toBe(true);

        // Also check that no "push-" bookmark was created
        const pushRefs = remoteRepo.listGitRefs('refs/heads/push-');
        expect(pushRefs.length).toBe(0);
    });
});
