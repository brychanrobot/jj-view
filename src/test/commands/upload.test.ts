/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CodeForgeProvider, StackCommitNode } from '../../core/code-forge-provider';
import type { CodeForgeService } from '../../core/code-forge-service';
import {
    buildStackPushArgs,
    isEligibleForAutoStackedUpload,
    resolveStackCommits,
    resolveStackedUploadCommand,
    uploadCommand,
    uploadStackCommand,
} from '../../core/commands/upload';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import type { JjBookmark, JjLogEntry } from '../../core/jj-types';
import { createUploadPayload, createUploadStackPayload } from '../../vscode/payloads/upload.payload';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('uploadCommand', () => {
    let jjService: JjService;
    let repo: TestRepo;
    let remoteRepos: TestRepo[] = [];
    let codeForgeService: CodeForgeService;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        remoteRepos = [];
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path, NO_OP_LOGGER);

        codeForgeService = createMock<CodeForgeService>({
            isEnabled: true,
            activeProvider: undefined,
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
        repo.dispose();
        for (const r of remoteRepos) {
            r.dispose();
        }
        remoteRepos = [];
        vi.clearAllMocks();
    });

    async function setupRemote() {
        const remoteRepo = new TestRepo();
        remoteRepo.init();
        remoteRepos.push(remoteRepo);
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

        expect(ctx.host.ui.errorMessages[0]).toContain('Upload failed');
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

        expect(ctx.host.ui.errorMessages[0]).toContain('Upload failed');
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

    describe('stacked upload support', () => {
        async function setupRemoteWithBase() {
            const remoteRepo = new TestRepo();
            remoteRepo.init();
            remoteRepos.push(remoteRepo);
            repo.addRemote('origin', remoteRepo.path);
            repo.config('remotes.origin.auto-track-bookmarks', '"*"');
            repo.config('git.push', '"origin"');

            // Initialize base branch on origin so commits on top of it have an immutable base
            repo.describe('base commit');
            repo.bookmark('base', '@');
            repo.gitPush('base');
            repo.config('revset-aliases."trunk()"', '"base@origin"');
            return remoteRepo;
        }

        test('resolveStackCommits returns commits in topological order (root to tip)', async () => {
            await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['bm-a'] },
                { label: 'commitB', parents: ['commitA'], description: 'commit B', bookmarks: ['bm-b'] },
                { label: 'commitC', parents: ['commitB'], description: 'commit C', bookmarks: ['bm-c'] },
            ]);

            const stack = await resolveStackCommits(jjService, ids.commitC.changeId);
            expect(stack.length).toBe(3);
            expect(stack[0].change_id).toBe(ids.commitA.changeId);
            expect(stack[1].change_id).toBe(ids.commitB.changeId);
            expect(stack[2].change_id).toBe(ids.commitC.changeId);
        });

        test('isEligibleForAutoStackedUpload requires multiple commits and all to have local bookmarks', () => {
            const makeCommit = (
                commitId: string,
                parentIds: string[],
                bookmarks?: Array<{ name: string; remote?: string }>,
            ) =>
                createMock<JjLogEntry>({
                    commit_id: commitId,
                    parents: parentIds.map((pid) => ({ commit_id: pid, change_id: pid, is_immutable: false })),
                    bookmarks: bookmarks?.map((b) => createMock<JjBookmark>({ name: b.name, remote: b.remote })),
                });

            // Single commit
            expect(isEligibleForAutoStackedUpload([makeCommit('c1', ['root'], [{ name: 'b1' }])])).toBe(false);

            // Multiple commits, linear chain, all have local bookmarks
            expect(
                isEligibleForAutoStackedUpload([
                    makeCommit('c1', ['root'], [{ name: 'b1' }]),
                    makeCommit('c2', ['c1'], [{ name: 'b2' }]),
                ]),
            ).toBe(true);

            // Multiple commits, non-linear chain (merge / wrong parent)
            expect(
                isEligibleForAutoStackedUpload([
                    makeCommit('c1', ['root'], [{ name: 'b1' }]),
                    makeCommit('c2', ['other'], [{ name: 'b2' }]),
                ]),
            ).toBe(false);

            // Multiple commits, one has only remote bookmark
            expect(
                isEligibleForAutoStackedUpload([
                    makeCommit('c1', ['root'], [{ name: 'b1' }]),
                    makeCommit('c2', ['c1'], [{ name: 'b2', remote: 'origin' }]),
                ]),
            ).toBe(false);

            // Multiple commits, one has no bookmarks
            expect(
                isEligibleForAutoStackedUpload([
                    makeCommit('c1', ['root'], [{ name: 'b1' }]),
                    makeCommit('c2', ['c1'], []),
                ]),
            ).toBe(false);
        });

        test('buildStackPushArgs generates -r for bookmarked commits and -c for unbookmarked', () => {
            const commitA = createMock<JjLogEntry>({
                change_id: 'ch-a',
                bookmarks: [createMock<JjBookmark>({ name: 'bm-a' })],
            });
            const commitB = createMock<JjLogEntry>({
                change_id: 'ch-b',
                bookmarks: [],
            });
            const commitC = createMock<JjLogEntry>({
                change_id: 'ch-c',
                bookmarks: [createMock<JjBookmark>({ name: 'bm-c' })],
            });

            const args = buildStackPushArgs([commitA, commitB, commitC]);
            expect(args).toEqual(['-r', 'bm-a', '-c', 'ch-b', '-r', 'bm-c']);
        });

        test('auto-detects stacked upload when all commits in revset have bookmarks', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'stacked commit A', bookmarks: ['stack-a'] },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'stacked commit B',
                    bookmarks: ['stack-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            await uploadCommand(ctx, { revision: ids.commitB.changeId });

            // Both bookmarks should have been pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
        });

        test('auto-detect falls back to single-commit upload when an intermediate commit lacks a bookmark', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'unbookmarked commit A' },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'bookmarked commit B',
                    bookmarks: ['tip-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            await uploadCommand(ctx, { revision: ids.commitB.changeId });

            // Only tip-b is pushed; no push- bookmark generated for commitA
            expect(remoteRepo.hasGitRef('refs/heads/tip-b')).toBe(true);
            const pushRefs = remoteRepo.listGitRefs('refs/heads/push-');
            expect(pushRefs.length).toBe(0);
        });

        test('explicit uploadStackCommand pushes entire stack creating bookmarks for unbookmarked commits', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'unbookmarked commit A' },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'bookmarked commit B',
                    bookmarks: ['tip-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            await uploadStackCommand(ctx, { revision: ids.commitB.changeId });

            // Both tip-b and auto-generated push bookmark for commitA are pushed
            expect(remoteRepo.hasGitRef('refs/heads/tip-b')).toBe(true);
            const pushRefs = remoteRepo.listGitRefs('refs/heads/push-');
            expect(pushRefs.length).toBe(1);
        });

        test('explicit mode: single pushes only targeted commit even when all stack commits have bookmarks', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A',
                    bookmarks: ['stack-a'],
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B',
                    bookmarks: ['stack-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            await uploadCommand(ctx, { revision: ids.commitB.changeId, mode: 'single' });

            // Only stack-b is pushed; stack-a is not pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(false);
        });

        test('delegates to uploadStackCommand when alwaysUploadStack is enabled, even with mode single', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'stacked commit A', bookmarks: ['stack-a'] },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'stacked commit B',
                    bookmarks: ['stack-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            ctx.host.config.set('alwaysUploadStack', true);

            await uploadCommand(ctx, { revision: ids.commitB.changeId, mode: 'single' });

            // Both bookmarks in the stack should have been uploaded to remote
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
        });

        test('uploading a commit partway up a stack pushes only that commit and its ancestors, not its children', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A (root)',
                    bookmarks: ['stack-a'],
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B (middle - target)',
                    bookmarks: ['stack-b'],
                },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C (child / descendant)',
                    bookmarks: ['stack-c'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            let syncedStack: StackCommitNode[] | undefined;
            const mockProvider = createMock<CodeForgeProvider>({
                syncStackedChanges: vi.fn().mockImplementation(async (stack: StackCommitNode[]) => {
                    syncedStack = stack;
                    return { created: [], retargeted: [], unchanged: [] };
                }),
            });
            const forgeService = createMock<CodeForgeService>({
                isEnabled: true,
                requestRefreshWithBackoffs: vi.fn(),
                activeProvider: mockProvider,
            });
            mockJjRepo = createMock<JjRepository>({
                jj: jjService,
                codeForge: forgeService,
                refresh: vi.fn().mockResolvedValue(undefined),
            });
            ctx = new FakeCommandContext(mockJjRepo);

            // Upload stack targeting the middle commit (commitB)
            await uploadStackCommand(ctx, { revision: ids.commitB.changeId });

            // Ancestor (commitA) and target (commitB) must be pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);

            // Child/descendant (commitC) must NOT be pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-c')).toBe(false);

            // Provider sync must only receive commits up to commitB
            expect(syncedStack).toBeDefined();
            expect(syncedStack?.map((n) => n.bookmark)).toEqual(['stack-a', 'stack-b']);
        });

        test('auto-detect upload on middle commit pushes ancestors and target commit, excluding children', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A',
                    bookmarks: ['stack-a'],
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B (middle)',
                    bookmarks: ['stack-b'],
                },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C (child)',
                    bookmarks: ['stack-c'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            // Call uploadCommand with mode: 'auto' on commitB
            await uploadCommand(ctx, { revision: ids.commitB.changeId, mode: 'auto' });

            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-c')).toBe(false);
        });

        test('upload stack on middle commit does not push child even when child bookmark is tracked', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A',
                    bookmarks: ['stack-a'],
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B (middle)',
                    bookmarks: ['stack-b'],
                },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C (child)',
                    bookmarks: ['stack-c'],
                },
            ]);

            // Push stack-c so it is tracked on origin
            repo.gitPush('stack-c');
            expect(remoteRepo.hasGitRef('refs/heads/stack-c')).toBe(true);
            const initialChildSha = remoteRepo.getGitRefSha('refs/heads/stack-c');

            // Now mutate commitC so local bookmark has new changes that could be pushed
            repo.new([ids.commitC.changeId], 'commit C updated');
            repo.bookmarkMove('stack-c', '@');

            // User right-clicks commitB and triggers Upload Stack via payload
            const payload = createUploadStackPayload([
                { webviewSection: 'commit', commitId: ids.commitB.commitId, changeId: ids.commitB.changeId },
            ]);

            await uploadStackCommand(ctx, payload);

            // stack-a and stack-b should be pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);

            // stack-c should NOT have been updated on remote
            const finalChildSha = remoteRepo.getGitRefSha('refs/heads/stack-c');
            expect(finalChildSha).toBe(initialChildSha);
        });

        test('upload via context menu payload defaults to single commit and excludes other bookmarks', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A',
                    bookmarks: ['stack-a'],
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B (middle)',
                    bookmarks: ['stack-b'],
                },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C (child)',
                    bookmarks: ['stack-c'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            const payload = createUploadPayload([
                { webviewSection: 'commit', commitId: ids.commitB.commitId, changeId: ids.commitB.changeId },
            ]);

            await uploadCommand(ctx, payload);

            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(false);
            expect(remoteRepo.hasGitRef('refs/heads/stack-c')).toBe(false);
        });

        test('auto-detect falls back to single-commit upload when ancestor lacks bookmark, without uploading child with bookmark', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A (unbookmarked)',
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B (middle)',
                    bookmarks: ['stack-b'],
                },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C (child)',
                    bookmarks: ['stack-c'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            const payload = createUploadPayload([
                { webviewSection: 'commit', commitId: ids.commitB.commitId, changeId: ids.commitB.changeId },
            ]);

            await uploadCommand(ctx, payload);

            // Single upload on commitB pushes stack-b only
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
            // Neither unbookmarked ancestor commitA nor child commitC are pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-c')).toBe(false);
        });

        test('explicit uploadStackCommand pushes ancestor and target, excluding child with bookmark even when ancestor lacks bookmark', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A (unbookmarked)',
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B (middle)',
                    bookmarks: ['stack-b'],
                },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C (child)',
                    bookmarks: ['stack-c'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            const payload = createUploadStackPayload([
                { webviewSection: 'commit', commitId: ids.commitB.commitId, changeId: ids.commitB.changeId },
            ]);

            await uploadStackCommand(ctx, payload);

            // commitA is pushed with an auto-generated bookmark
            const remoteRefs = remoteRepo.listGitRefs('refs/heads/');
            expect(remoteRefs.some((r) => r.includes('push-'))).toBe(true);
            // commitB is pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
            // Child commitC is NOT pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-c')).toBe(false);
        });

        test('notifies user of created and retargeted PRs when provider syncs stacked changes', async () => {
            await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['stack-a'] },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B',
                    bookmarks: ['stack-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            const mockProvider = createMock<CodeForgeProvider>({
                syncStackedChanges: vi.fn().mockResolvedValue({
                    created: [
                        {
                            changeId: ids.commitA.changeId,
                            prNumber: 101,
                            url: 'https://github.com/test/repo/pull/101',
                            base: 'base',
                            head: 'stack-a',
                        },
                    ],
                    retargeted: [
                        {
                            changeId: ids.commitB.changeId,
                            prNumber: 102,
                            url: 'https://github.com/test/repo/pull/102',
                            oldBase: 'base',
                            newBase: 'stack-a',
                        },
                    ],
                    unchanged: [],
                }),
            });
            vi.spyOn(codeForgeService, 'activeProvider', 'get').mockReturnValue(mockProvider);

            await uploadStackCommand(ctx, { revision: ids.commitB.changeId });

            expect(mockProvider.syncStackedChanges).toHaveBeenCalled();
            expect(ctx.host.ui.infoMessages).toContain('Upload successful. Created: #101; Retargeted: #102');
        });

        test('stacked upload with unbookmarked middle commit includes generated bookmark in syncStackedChanges', async () => {
            await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['stack-a'] },
                { label: 'commitB', parents: ['commitA'], description: 'middle unbookmarked commit' },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C',
                    bookmarks: ['stack-c'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            let passedNodes: StackCommitNode[] = [];
            const mockProvider = createMock<CodeForgeProvider>({
                syncStackedChanges: vi.fn().mockImplementation(async (nodes: StackCommitNode[]) => {
                    passedNodes = nodes;
                    return { created: [], retargeted: [], unchanged: [] };
                }),
            });
            vi.spyOn(codeForgeService, 'activeProvider', 'get').mockReturnValue(mockProvider);

            await uploadStackCommand(ctx, { revision: ids.commitC.changeId });

            expect(mockProvider.syncStackedChanges).toHaveBeenCalled();
            expect(passedNodes.map((n) => n.changeId)).toEqual([
                ids.commitA.changeId,
                ids.commitB.changeId,
                ids.commitC.changeId,
            ]);
            expect(passedNodes[1]?.bookmark).toMatch(/^push-/);
        });

        test('isolated PR sync error warns user without suggesting Configure Upload', async () => {
            await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['stack-a'] },
            ]);

            const mockProvider = createMock<CodeForgeProvider>({
                syncStackedChanges: vi.fn().mockRejectedValue(new Error('Network error on GitHub GraphQL')),
            });
            vi.spyOn(codeForgeService, 'activeProvider', 'get').mockReturnValue(mockProvider);

            await uploadStackCommand(ctx, { revision: ids.commitA.changeId });

            expect(ctx.host.ui.warningMessages).toContain(
                'Upload succeeded, but pull request synchronization failed: Network error on GitHub GraphQL',
            );
            expect(ctx.host.nav.settingsOpened).not.toContain('jj-view.uploadCommand');
        });

        test('invokes prepareStackedChanges with bookmarked stack nodes prior to upload', async () => {
            await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['stack-a'] },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B',
                    bookmarks: ['stack-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            const callOrder: string[] = [];
            const mockProvider = createMock<CodeForgeProvider>({
                prepareStackedChanges: vi.fn().mockImplementation(async (nodes: StackCommitNode[]) => {
                    callOrder.push(`prepare:${nodes.map((n) => n.bookmark).join(',')}`);
                }),
                syncStackedChanges: vi.fn().mockImplementation(async (nodes: StackCommitNode[]) => {
                    callOrder.push(`sync:${nodes.map((n) => n.bookmark).join(',')}`);
                    return { created: [], retargeted: [], unchanged: [] };
                }),
            });
            vi.spyOn(codeForgeService, 'activeProvider', 'get').mockReturnValue(mockProvider);

            await uploadStackCommand(ctx, { revision: ids.commitB.changeId });

            expect(mockProvider.prepareStackedChanges).toHaveBeenCalled();
            expect(mockProvider.syncStackedChanges).toHaveBeenCalled();
            expect(callOrder[0]).toBe('prepare:stack-a,stack-b');
            expect(callOrder[1]).toBe('sync:stack-a,stack-b');
        });

        test('empty working copy @ falls back to @- when target is specified by change ID', async () => {
            await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['stack-a'] },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B',
                    bookmarks: ['stack-b'],
                },
            ]);
            // Create an empty working copy on top of commitB
            repo.new([ids.commitB.changeId], '');
            const currentEntries = await jjService.getLog({ revision: '@' });
            const workingCopyChangeId = currentEntries[0].change_id;

            // Pass the working copy changeId as target revision
            const stack = await resolveStackCommits(jjService, workingCopyChangeId);
            expect(stack.length).toBe(2);
            expect(stack[0].change_id).toBe(ids.commitA.changeId);
            expect(stack[1].change_id).toBe(ids.commitB.changeId);
        });

        test('resolveStackedUploadCommand throws error on non-linear stack', async () => {
            await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['stack-a'] },
                { label: 'commitB', parents: ['base'], description: 'commit B', bookmarks: ['stack-b'] },
                {
                    label: 'commitM',
                    parents: ['commitA', 'commitB'],
                    description: 'merge commit',
                    bookmarks: ['stack-m'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            await expect(resolveStackedUploadCommand(mockJjRepo, ids.commitM.changeId)).rejects.toThrow(
                'Stacked upload requires a linear sequence of commits',
            );
        });

        test('resolveStackedUploadCommand appends stack args to custom uploadCommand', async () => {
            await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['bm-a'] },
                { label: 'commitB', parents: ['commitA'], description: 'commit B', bookmarks: ['bm-b'] },
            ]);

            const resolved = await resolveStackedUploadCommand(
                mockJjRepo,
                ids.commitB.changeId,
                'git push --force-with-lease',
            );
            expect(resolved.subcommand).toBe('git');
            expect(resolved.commandArgs).toEqual(['push', '--force-with-lease', '-r', 'bm-a', '-r', 'bm-b']);
        });

        test('uploadStackCommand proceeds with upload when prepareStackedChanges fails', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['stack-a'] },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B',
                    bookmarks: ['stack-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            const mockProvider = createMock<CodeForgeProvider>({
                prepareStackedChanges: vi.fn().mockRejectedValue(new Error('Pre-push preparation failed')),
                syncStackedChanges: vi.fn().mockResolvedValue({ created: [], retargeted: [], unchanged: [] }),
            });
            vi.spyOn(codeForgeService, 'activeProvider', 'get').mockReturnValue(mockProvider);

            await uploadStackCommand(ctx, { revision: ids.commitB.changeId });

            expect(mockProvider.prepareStackedChanges).toHaveBeenCalled();
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
        });

        test('custom uploadCommand uploads working copy when revision argument is undefined', async () => {
            repo.describe('root commit');
            const ids = await buildGraph(repo, [
                { label: 'commitA', description: 'test custom upload undefined rev', bookmarks: ['feature-def'] },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'test custom upload undefined rev 2',
                    isCurrentWorkingCopy: true,
                },
            ]);

            const remoteRepo = await setupRemote();

            repo.gitPush('feature-def');
            repo.bookmarkMove('feature-def', ids.commitB.changeId);

            ctx.host.config.set('uploadCommand', 'git push');

            await uploadCommand(ctx, undefined);

            expect(remoteRepo.hasGitRef('refs/heads/feature-def')).toBe(true);
            expect(mockJjRepo.refresh).toHaveBeenCalled();
            expect(codeForgeService.requestRefreshWithBackoffs).toHaveBeenCalled();
        });

        test('uploadCommand does not perform stacked upload on Gerrit repository even when alwaysUploadStack is true', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['stack-a'] },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B',
                    bookmarks: ['stack-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            const mockGerritProvider = createMock<CodeForgeProvider>({
                id: 'gerrit',
                prepareStackedChanges: vi.fn(),
                syncStackedChanges: vi.fn(),
                getUploadCommand: vi
                    .fn()
                    .mockImplementation((rev: string) => ({ subcommand: 'git', args: ['push', '-r', rev] })),
            });
            codeForgeService = createMock<CodeForgeService>({
                isEnabled: true,
                activeProvider: mockGerritProvider,
                requestRefreshWithBackoffs: vi.fn(),
            });
            mockJjRepo = createMock<JjRepository>({
                jj: jjService,
                codeForge: codeForgeService,
                refresh: vi.fn().mockResolvedValue(undefined),
            });
            ctx = new FakeCommandContext(mockJjRepo);
            ctx.host.config.set('alwaysUploadStack', true);

            await uploadCommand(ctx, { revision: ids.commitB.changeId });

            expect(mockGerritProvider.prepareStackedChanges).not.toHaveBeenCalled();
            expect(mockGerritProvider.syncStackedChanges).not.toHaveBeenCalled();
            // Should have pushed single commitB (stack-b), not stacked (stack-a should not be pushed)
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(false);
        });

        test('uploadStackCommand shows warning and exits early on Gerrit repositories', async () => {
            const mockGerritProvider = createMock<CodeForgeProvider>({
                id: 'gerrit',
            });
            codeForgeService = createMock<CodeForgeService>({
                isEnabled: true,
                activeProvider: mockGerritProvider,
                requestRefreshWithBackoffs: vi.fn(),
            });
            mockJjRepo = createMock<JjRepository>({
                jj: jjService,
                codeForge: codeForgeService,
                refresh: vi.fn().mockResolvedValue(undefined),
            });
            ctx = new FakeCommandContext(mockJjRepo);

            await uploadStackCommand(ctx, { revision: '@' });

            expect(ctx.host.ui.warningMessages).toContain(
                'Stacked uploads are not supported for Gerrit repositories. Use standard upload instead.',
            );
        });

        test('resolveStackedUploadCommand reuses pre-resolved stack commits', async () => {
            const dummyCommits: JjLogEntry[] = [
                createMock<JjLogEntry>({
                    commit_id: 'commit-1',
                    change_id: 'change-1',
                    bookmarks: [{ name: 'bm-1' }],
                    parents: [],
                }),
                createMock<JjLogEntry>({
                    commit_id: 'commit-2',
                    change_id: 'change-2',
                    bookmarks: [{ name: 'bm-2' }],
                    parents: [{ commit_id: 'commit-1', change_id: 'change-1', is_immutable: false }],
                }),
            ];

            const result = await resolveStackedUploadCommand(mockJjRepo, '@', undefined, dummyCommits);
            expect(result.stackCommits).toBe(dummyCommits);
            expect(result.commandArgs).toEqual(['push', '-r', 'bm-1', '-r', 'bm-2']);
        });
    });
});
