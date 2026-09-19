/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ChangeStatusRequest } from '../core/code-forge-provider';
import { GerritProvider } from '../core/gerrit-provider';
import type { JjService } from '../core/jj-service';
import type { CodeForgeChangeInfo } from '../core/jj-types';
import type { AsyncCache } from '../utils/async-cache';
import { resolveGerritChangeKey, stripGerritTrailers } from '../utils/gerrit-utils';
import type { LruCache } from '../utils/lru-cache';
import { FakeHostEnvironment } from './fake-host-environment';
import { FakeGerritServer } from './helpers/fake-gerrit-server';
import { accessPrivate, createMock, createMockLogOutputChannel, exposePrivate, setPrivate } from './test-utils';

// Mock VS Code
vi.mock('vscode', () => ({
    Disposable: class {
        static from = vi.fn();
        dispose() {}
    },
    EventEmitter: class {
        event = vi.fn();
        fire = vi.fn();
        dispose = vi.fn();
    },
}));

describe('Gerrit Utils', () => {
    test('resolveGerritChangeKey strictly matches Gerrit host for Link: trailers', () => {
        const host = 'https://gerrit-review.googlesource.com';

        // Matching host with /+/ change number format
        expect(resolveGerritChangeKey('Link: https://gerrit-review.googlesource.com/+/12345\n', host)).toBe('12345');

        // Matching host with direct change number format
        expect(resolveGerritChangeKey('Link: https://gerrit-review.googlesource.com/12345\n', host)).toBe('12345');

        // Mismatched host (e.g. GitHub issue/PR links)
        expect(resolveGerritChangeKey('Link: https://github.com/owner/repo/pull/12345\n', host)).toBeUndefined();

        // Standard Change-Id still resolves
        expect(resolveGerritChangeKey('Change-Id: Iabcdef1234567890abcdef1234567890abcdef12\n', host)).toBe(
            'Iabcdef1234567890abcdef1234567890abcdef12',
        );
    });

    test('stripGerritTrailers removes Change-Id and Link trailers', () => {
        const desc =
            'My commit message\n\nChange-Id: Iabcdef1234567890abcdef1234567890abcdef12\nLink: https://gerrit-review.googlesource.com/+/12345\n';
        expect(stripGerritTrailers(desc)).toBe('My commit message');
    });
});

describe('GerritProvider', () => {
    let provider: GerritProvider;
    let mockJjService: JjService;
    let mockOutputChannel: vscode.LogOutputChannel;
    let host: FakeHostEnvironment;

    beforeEach(() => {
        host = new FakeHostEnvironment();
        mockJjService = createMock<JjService>({});
        mockOutputChannel = createMockLogOutputChannel({ appendLine: vi.fn() });
        provider = new GerritProvider(mockOutputChannel, host);
    });

    test('detect trims and checks for blank gerrit.host setting', async () => {
        host.config.set('gerrit.host', '   '); // whitespace only

        // With blank host, should fall back to checking .gitreview/remotes and return false since they don't exist
        const result = await provider.detect('/root', []);
        expect(result).toBe(false);
        expect(accessPrivate(provider, 'gerritHost')).toBeUndefined();
    });

    test('detect reads gerrit.host from git configuration as fallback', async () => {
        const tempRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gerrit-provider-detect-gitconfig-'));
        const gitRoot = path.join(tempRepoDir, '.git');
        cp.execSync(`git init --bare "${gitRoot}"`);
        cp.execSync(`git --git-dir="${gitRoot}" config gerrit.host "git-config-host.example.com"`);

        host.config.set('binaryPath', 'jj');

        setPrivate(provider, 'repoRoot', tempRepoDir);
        setPrivate(provider, 'gitRoot', gitRoot);

        vi.spyOn(
            exposePrivate<{ probeGerritHost(host: string): Promise<boolean> }>(provider),
            'probeGerritHost',
        ).mockResolvedValue(true);

        const result = await provider.detect(tempRepoDir, []);
        expect(result).toBe(true);
        expect(accessPrivate(provider, 'gerritHost')).toBe('https://git-config-host.example.com');

        await fs.rm(tempRepoDir, { recursive: true, force: true });
    });

    test('resolveCacheKey returns undefined for non-JJ values without conversion', () => {
        const resolveKey = exposePrivate<{
            resolveCacheKey(changeId?: string, description?: string): string | undefined;
        }>(provider).resolveCacheKey.bind(provider);

        expect(resolveKey('@')).toBeUndefined();
        expect(resolveKey('@-')).toBeUndefined();
        expect(resolveKey('d239d787')).toBeUndefined();
        expect(resolveKey(undefined)).toBeUndefined();
        expect(resolveKey('')).toBeUndefined();
    });

    test('resolveCacheKey converts valid JJ Change-Ids (including suffixes) as expected', () => {
        const resolveKey = exposePrivate<{
            resolveCacheKey(changeId?: string, description?: string): string | undefined;
        }>(provider).resolveCacheKey.bind(provider);

        // JJ Change-Ids (k-z letters) without suffix should convert successfully
        expect(resolveKey('zzzz')).toBe('I0000');
        expect(resolveKey('yyyy')).toBe('I1111');

        // JJ Change-Ids with suffixes should be split on "/" before conversion
        expect(resolveKey('zzzz/123')).toBe('I0000');
    });

    test('fetchStatuses preserves cache on transient fetchBatchFromNetwork error', async () => {
        setPrivate(provider, 'gerritHost', 'https://my-gerrit-host.com');

        // Populate cache
        const cache = accessPrivate<LruCache<string, unknown>>(provider, 'cache');
        cache.set('I12345', {
            id: 'I12345',
            number: 123,
            displayLabel: 'CL/123',
            providerName: 'Gerrit',
            status: 'NEW',
            submittable: true,
            url: 'url',
            currentRevision: 'sha-1',
        });

        // Mock fetchBatchFromNetwork to throw
        vi.spyOn(
            exposePrivate<{
                fetchBatchFromNetwork(cacheKeys: string[]): Promise<Map<string, unknown>>;
            }>(provider),
            'fetchBatchFromNetwork',
        ).mockRejectedValue(new Error('Transient network error'));

        const changes: ChangeStatusRequest[] = [
            {
                commitId: 'sha-1',
                changeId: 'I12345',
                parents: [],
            },
        ];

        const result = await provider.fetchStatuses(changes, mockJjService);
        expect(result).toBe(false); // No cache changes were registered

        // Verify cache was preserved (not deleted)
        expect(cache.get('I12345')).toBeDefined();
        const cachedEntry = cache.get('I12345') as { status: string } | undefined;
        expect(cachedEntry?.status).toBe('NEW');
    });

    test('fetchStatuses emits granular [timing] logs for batches and overall completion', async () => {
        setPrivate(provider, 'gerritHost', 'https://my-gerrit-host.com');

        vi.spyOn(
            exposePrivate<{
                fetchBatchFromNetwork(
                    cacheKeys: string[],
                    batchIndex?: number,
                    totalBatches?: number,
                ): Promise<Map<string, CodeForgeChangeInfo>>;
            }>(provider),
            'fetchBatchFromNetwork',
        ).mockResolvedValue(
            new Map([
                [
                    'I12345',
                    createMock<CodeForgeChangeInfo>({
                        id: 'I12345',
                        number: 123,
                        displayLabel: 'CL/123',
                        providerName: 'Gerrit',
                        status: 'NEW',
                        submittable: true,
                        url: 'url',
                        unresolvedComments: 0,
                        currentRevision: 'sha-1',
                        files: {},
                    }),
                ],
            ]),
        );

        const changes: ChangeStatusRequest[] = [
            {
                commitId: 'sha-1',
                changeId: 'I12345',
                parents: [],
            },
        ];

        await provider.fetchStatuses(changes, mockJjService);

        const infoCalls = (mockOutputChannel.info as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) =>
            String(call[0]),
        );
        const timingCalls = infoCalls.filter((msg: string) => msg.includes('[timing] [Gerrit]'));
        expect(timingCalls).toEqual(
            expect.arrayContaining([
                expect.stringMatching(
                    /^\[timing\] \[Gerrit\] batch 1\/1 content sync verification took \d+ms \(1 hits, 0 checks\)$/,
                ),
                expect.stringMatching(/^\[timing\] \[Gerrit\] fetchStatuses took \d+ms \(1 changes in 1 batch\)$/),
            ]),
        );
    });

    test('fetchBatchFromNetwork maps prefix changeId and change number to results', async () => {
        setPrivate(provider, 'gerritHost', 'https://my-gerrit-host.com');

        const mockGerritChanges = [
            {
                change_id: 'Ida7a9a26e1e29c5429f25219b39053596a6a6964',
                _number: 7667404,
                status: 'NEW',
                submittable: true,
                current_revision: 'sha-1',
            },
        ];

        vi.spyOn(
            exposePrivate<{ fetchGerrit(url: string): Promise<Response> }>(provider),
            'fetchGerrit',
        ).mockResolvedValue(
            new Response(`)]}'\n${JSON.stringify(mockGerritChanges)}`, {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );

        const fetchBatch = exposePrivate<{
            fetchBatchFromNetwork(cacheKeys: string[]): Promise<Map<string, CodeForgeChangeInfo>>;
        }>(provider).fetchBatchFromNetwork.bind(provider);

        // Prefix key (e.g. from JJ change ID)
        const results = await fetchBatch(['Ida7a9a26e1e29c5429f25219b3905359', '7667404']);
        expect(results.get('Ida7a9a26e1e29c5429f25219b3905359')).toBeDefined();
        expect(results.get('Ida7a9a26e1e29c5429f25219b3905359')?.number).toBe(7667404);
        expect(results.get('7667404')).toBeDefined();
        expect(results.get('7667404')?.id).toBe('Ida7a9a26e1e29c5429f25219b39053596a6a6964');
    });

    describe('Comments API', () => {
        let server: FakeGerritServer;

        beforeEach(async () => {
            server = new FakeGerritServer();
            await server.start();
            setPrivate(provider, 'gerritHost', server.url);

            // Populate cache
            const cache = accessPrivate<LruCache<string, CodeForgeChangeInfo>>(provider, 'cache');
            cache.set('I12345', {
                id: 'I12345',
                number: 123,
                displayLabel: 'CL/123',
                providerName: 'Gerrit',
                status: 'NEW',
                submittable: true,
                unresolvedComments: 0,
                url: `${server.url}/c/test-project/+/123`,
                currentRevision: 'sha-1',
            });
        });

        afterEach(async () => {
            await server.stop();
        });

        test('getCommentThreads fetches comments and drafts from Gerrit', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });
            server.registerDrafts(123, {
                'file.txt': [
                    {
                        id: 'draft-1',
                        in_reply_to: 'comment-1',
                        line: 10,
                        message: 'Draft reply',
                        updated: '2026-06-30T12:05:00Z',
                        unresolved: true,
                        author: { name: 'Me', username: 'me' },
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            expect(threads).toHaveLength(1);
            expect(threads[0].id).toBe('comment-1');
            expect(threads[0].filePath).toBe('file.txt');
            expect(threads[0].line).toBe(10);
            expect(threads[0].isResolved).toBe(false);
            expect(threads[0].comments).toHaveLength(2);
            const rootComment = threads[0].comments[0];
            const draftReply = threads[0].comments[1];
            expect(rootComment.body).toBe('First comment');
            expect(rootComment.isDraft).toBe(false);
            expect(draftReply.body).toBe('Draft reply');
            expect(draftReply.isDraft).toBe(true);
        });

        test('getCommentThreads fetches comments from Gerrit', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            expect(threads).toHaveLength(1);
            expect(threads[0].id).toBe('comment-1');
            expect(threads[0].filePath).toBe('file.txt');
            expect(threads[0].line).toBe(10);
            expect(threads[0].isResolved).toBe(false);
            expect(threads[0].comments[0].body).toBe('First comment');
        });

        test('getCommentThreads fetches comments from Gerrit and handles grouping/replies/orphans', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-2',
                        in_reply_to: 'comment-1',
                        line: 10,
                        message: 'Reply to first comment',
                        updated: '2026-06-30T12:01:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer B', username: 'rev_b' },
                    },
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                    {
                        id: 'comment-3',
                        in_reply_to: 'comment-2',
                        line: 10,
                        message: 'Nested reply in same thread',
                        updated: '2026-06-30T12:02:00Z',
                        unresolved: false,
                        author: { name: 'Reviewer C', username: 'rev_c' },
                    },
                    {
                        id: 'comment-4',
                        in_reply_to: 'missing-root',
                        line: 10,
                        message: 'Orphan reply whose parent is absent',
                        updated: '2026-06-30T12:03:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer D', username: 'rev_d' },
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            expect(threads).toHaveLength(2);

            // Thread 1: Groups comment-1, comment-2, comment-3
            const thread1 = threads.find((t) => t.id === 'comment-1');
            expect(thread1).toBeDefined();
            if (!thread1) {
                return;
            }
            expect(thread1.filePath).toBe('file.txt');
            expect(thread1.line).toBe(10);
            expect(thread1.isResolved).toBe(true); // Resolves to true because latest comment-3 unresolved is false
            expect(thread1.comments).toHaveLength(3);
            expect(thread1.comments[0].id).toBe('comment-1');
            expect(thread1.comments[1].id).toBe('comment-2');
            expect(thread1.comments[2].id).toBe('comment-3');

            // Thread 2: The orphan comment-4 starts its own thread
            const thread2 = threads.find((t) => t.id === 'comment-4');
            expect(thread2).toBeDefined();
            if (!thread2) {
                return;
            }
            expect(thread2.filePath).toBe('file.txt');
            expect(thread2.line).toBe(10);
            expect(thread2.isResolved).toBe(false); // unresolved is true
            expect(thread2.comments).toHaveLength(1);
            expect(thread2.comments[0].id).toBe('comment-4');
        });

        test('replyToCommentThread posts a reply', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            const reply = await provider.replyToCommentThread('I12345', threads[0], 'Thanks!');
            expect(reply.body).toBe('Thanks!');
            expect(reply.author.name).toBe('Gerrit User');
        });

        test('resolveCommentThread resolves/unresolves a thread', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            await provider.resolveCommentThread('I12345', threads[0], true);
            let updatedThreads = await provider.getCommentThreads('I12345');
            expect(updatedThreads[0].isResolved).toBe(true);

            await provider.resolveCommentThread('I12345', threads[0], false);
            updatedThreads = await provider.getCommentThreads('I12345');
            expect(updatedThreads[0].isResolved).toBe(false);
        });

        test('replyToCommentThread posts a reply targeting parent comment patchset', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        patch_set: 2,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            const reply = await provider.replyToCommentThread('I12345', threads[0], 'Thanks!');
            expect(reply.body).toBe('Thanks!');
            expect(server.requests.some((req) => req.includes('/changes/123/revisions/2/drafts'))).toBe(true);
        });

        test('replyToCommentThread falls back to current revision when patch_set is missing', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            const reply = await provider.replyToCommentThread('I12345', threads[0], 'Thanks!');
            expect(reply.body).toBe('Thanks!');
            expect(server.requests.some((req) => req.includes('/changes/123/revisions/current/drafts'))).toBe(true);
        });

        test('resolveCommentThread posts a resolution targeting parent comment patchset', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        patch_set: 3,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            await provider.resolveCommentThread('I12345', threads[0], true);
            expect(server.requests.some((req) => req.includes('/changes/123/revisions/3/drafts'))).toBe(true);
        });

        test('surfaces Gerrit error response body on failure in replyToCommentThread', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            server.failDraftsWithStatus = 400;
            server.failDraftsResponseBody =
                'Invalid comment in_reply_to. Comment replies must be submitted on the same patchset as the parent comment.\n';

            const threads = await provider.getCommentThreads('I12345');
            await expect(provider.replyToCommentThread('I12345', threads[0], 'Thanks!')).rejects.toThrow(
                'Failed to post Gerrit draft reply: 400 Bad Request - Invalid comment in_reply_to. Comment replies must be submitted on the same patchset as the parent comment.',
            );
        });

        test('surfaces Gerrit error response body on failure in resolveCommentThread', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            server.failDraftsWithStatus = 400;
            server.failDraftsResponseBody =
                'Invalid comment in_reply_to. Comment replies must be submitted on the same patchset as the parent comment.';

            const threads = await provider.getCommentThreads('I12345');
            await expect(provider.resolveCommentThread('I12345', threads[0], true)).rejects.toThrow(
                'Failed to resolve Gerrit comment: 400 Bad Request - Invalid comment in_reply_to. Comment replies must be submitted on the same patchset as the parent comment.',
            );
        });

        test('replyToCommentThread and resolveCommentThread use thread metadata without re-fetching comments', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        patch_set: 2,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            server.clearRequests();

            await provider.resolveCommentThread('I12345', threads[0], true);
            expect(server.requests.some((req) => req.includes('/comments'))).toBe(false);
            expect(server.requests.some((req) => req.includes('/changes/123/revisions/2/drafts'))).toBe(true);
        });

        test('replyToCommentThread falls back to re-fetching when draft creation response is empty', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        patch_set: 2,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            server.emptyDraftResponseBody = true;
            const threads = await provider.getCommentThreads('I12345');
            const reply = await provider.replyToCommentThread('I12345', threads[0], 'Fallback draft reply');
            expect(reply.body).toBe('Fallback draft reply');
            expect(reply.isDraft).toBe(true);
        });

        test('replyToCommentThread defaults missing filePath to /PATCHSET_LEVEL', async () => {
            server.registerComments(123, {
                '/PATCHSET_LEVEL': [
                    {
                        id: 'comment-cl',
                        line: 0,
                        message: 'CL level comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        patch_set: 1,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            const threadWithoutPath = { ...threads[0], filePath: undefined };
            const reply = await provider.replyToCommentThread('I12345', threadWithoutPath, 'Reply to CL comment');
            expect(reply.body).toBe('Reply to CL comment');
        });

        test('replyToCommentThread with resolved parameter updates unresolved status', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        patch_set: 1,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            const reply = await provider.replyToCommentThread('I12345', threads[0], 'Resolved reply', true);
            expect(reply.body).toBe('Resolved reply');
        });

        test('attaches authentication headers and rewrites URL when auth is available', async () => {
            const tempRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gerrit-auth-test-'));
            const gitRoot = path.join(tempRepoDir, '.git');
            cp.execSync(`git init --bare "${gitRoot}"`);
            cp.execSync(
                `git --git-dir="${gitRoot}" config credential.helper "!f() { echo username=testuser; echo password=testpass; }; f"`,
            );

            setPrivate(provider, 'repoRoot', tempRepoDir);
            setPrivate(provider, 'gitRoot', gitRoot);

            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            await provider.getCommentThreads('I12345');

            expect(server.requests).toContain('/a/changes/123/comments');
            expect(server.requests).not.toContain('/changes/123/comments');

            expect(server.lastHeaders).toBeDefined();
            const expectedAuth = Buffer.from('testuser:testpass').toString('base64');
            expect(server.lastHeaders?.authorization).toBe(`Basic ${expectedAuth}`);

            await fs.rm(tempRepoDir, { recursive: true, force: true });
        });

        test('does not rewrite URL or send auth headers when auth is unavailable', async () => {
            const tempRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gerrit-auth-test-unauth-'));
            const gitRoot = path.join(tempRepoDir, '.git');
            cp.execSync(`git init --bare "${gitRoot}"`);

            // No credential.helper is configured and no cookies are present.
            setPrivate(provider, 'repoRoot', tempRepoDir);
            setPrivate(provider, 'gitRoot', gitRoot);

            server.clearRequests();
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });

            await provider.getCommentThreads('I12345');

            expect(server.requests).toContain('/changes/123/comments');
            expect(server.requests).not.toContain('/a/changes/123/comments');

            expect(server.lastHeaders).toBeDefined();
            expect(server.lastHeaders?.authorization).toBeUndefined();
            expect(server.lastHeaders?.cookie).toBeUndefined();

            await fs.rm(tempRepoDir, { recursive: true, force: true });
        });

        test('reuses cached authentication header and clearCache forces recomputation', async () => {
            const tempRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gerrit-auth-cache-test-'));
            const gitRoot = path.join(tempRepoDir, '.git');
            cp.execSync(`git init --bare "${gitRoot}"`);

            const logFile = path.join(tempRepoDir, 'call_log.txt');
            cp.execSync(
                `git --git-dir="${gitRoot}" config credential.helper "!f() { echo username=testuser; echo password=testpass; echo invoked >> \\"${logFile}\\"; }; f"`,
            );

            setPrivate(provider, 'repoRoot', tempRepoDir);
            setPrivate(provider, 'gitRoot', gitRoot);

            server.clearRequests();
            server.registerComments(123, {});

            // First call - should trigger credential helper
            await provider.getCommentThreads('I12345');

            // Second call - should use cached credentials
            await provider.getCommentThreads('I12345');

            let logContent = await fs.readFile(logFile, 'utf8');
            let lines = logContent.trim().split('\n').filter(Boolean);
            expect(lines).toHaveLength(1);

            // Clear cache - should force helper invocation on next request
            provider.clearCache();

            // Repopulate cache for this changeId so getCommentThreads doesn't exit early
            const cache = accessPrivate<LruCache<string, CodeForgeChangeInfo>>(provider, 'cache');
            cache.set('I12345', {
                id: 'I12345',
                number: 123,
                displayLabel: 'CL/123',
                providerName: 'Gerrit',
                status: 'NEW',
                submittable: true,
                unresolvedComments: 0,
                url: `${server.url}/c/test-project/+/123`,
                currentRevision: 'sha-1',
            });

            await provider.getCommentThreads('I12345');

            logContent = await fs.readFile(logFile, 'utf8');
            lines = logContent.trim().split('\n').filter(Boolean);
            expect(lines).toHaveLength(2);

            await fs.rm(tempRepoDir, { recursive: true, force: true });
        });

        test('getCommentThreads caches results within TTL and does not make duplicate requests', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'First comment',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                        author: { name: 'Reviewer A', username: 'rev_a' },
                    },
                ],
            });
            server.registerDrafts(123, {
                'file.txt': [
                    {
                        id: 'draft-1',
                        in_reply_to: 'comment-1',
                        line: 10,
                        message: 'Draft reply',
                        updated: '2026-06-30T12:05:00Z',
                        unresolved: true,
                        author: { name: 'Me', username: 'me' },
                    },
                ],
            });

            // First call fetches from server
            const threads1 = await provider.getCommentThreads('I12345');
            expect(threads1).toHaveLength(1);
            expect(server.requests.filter((r) => r.includes('/comments'))).toHaveLength(1);
            expect(server.requests.filter((r) => r.includes('/drafts'))).toHaveLength(1);

            // Second call within TTL returns cached results with zero duplicate requests
            server.clearRequests();
            const threads2 = await provider.getCommentThreads('I12345');
            expect(threads2).toHaveLength(1);
            expect(server.requests).toHaveLength(0);
        });

        test('getCommentThreads coalesces concurrent in-flight requests', async () => {
            server.registerComments(123, {});
            server.registerDrafts(123, {});
            server.clearRequests();

            const [threads1, threads2] = await Promise.all([
                provider.getCommentThreads('I12345'),
                provider.getCommentThreads('I12345'),
            ]);

            expect(threads1).toEqual(threads2);
            expect(server.requests.filter((r) => r.includes('/comments'))).toHaveLength(1);
            expect(server.requests.filter((r) => r.includes('/drafts'))).toHaveLength(1);
        });

        test('replyToCommentThread records draft comment in cache, updates changeInfo, and fires onDidUpdate', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'Need fix',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            expect(threads).toHaveLength(1);

            let didUpdateFired = false;
            const disposable = provider.onDidUpdate(() => {
                didUpdateFired = true;
            });

            try {
                const reply = await provider.replyToCommentThread('I12345', threads[0], 'Fixed in draft');
                expect(reply.body).toBe('Fixed in draft');
                expect(reply.isDraft).toBe(true);
                expect(didUpdateFired).toBe(true);

                const cachedInfo = provider.getCachedChangeInfo('I12345');
                expect(cachedInfo?.draftComments).toBe(0);
                expect(cachedInfo?.draftResponses).toBe(1);
                expect(cachedInfo?.addressedThreads).toBe(1);
                expect(cachedInfo?.hasDraftResponses).toBe(true);
            } finally {
                disposable.dispose();
            }
        });

        test('resolveCommentThread records resolution draft, updates changeInfo, and fires onDidUpdate', async () => {
            server.registerComments(123, {
                'file.txt': [
                    {
                        id: 'comment-1',
                        line: 10,
                        message: 'Need fix',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                    },
                ],
            });

            const threads = await provider.getCommentThreads('I12345');
            expect(threads).toHaveLength(1);

            let didUpdateFired = false;
            const disposable = provider.onDidUpdate(() => {
                didUpdateFired = true;
            });

            try {
                await provider.resolveCommentThread('I12345', threads[0], true);
                expect(didUpdateFired).toBe(true);

                const cachedInfo = provider.getCachedChangeInfo('I12345');
                expect(cachedInfo?.draftComments).toBe(0);
                expect(cachedInfo?.draftResponses).toBe(1);
                expect(cachedInfo?.addressedThreads).toBe(1);
                expect(cachedInfo?.hasDraftResponses).toBe(true);
            } finally {
                disposable.dispose();
            }
        });

        test('fetchStatuses populates draftComments, draftResponses, and addressedThreads for changes with drafts', async () => {
            const changeNum = server.registerChange('I55555');
            server.registerComments(changeNum, {
                'file.txt': [
                    {
                        id: 'c1',
                        line: 5,
                        message: 'Please update',
                        updated: '2026-06-30T12:00:00Z',
                        unresolved: true,
                    },
                ],
            });
            server.registerDrafts(changeNum, {
                'file.txt': [
                    {
                        id: 'd1',
                        in_reply_to: 'c1',
                        line: 5,
                        message: 'Done',
                        updated: '2026-06-30T12:01:00Z',
                        unresolved: false,
                    },
                ],
            });

            const changed = await provider.fetchStatuses(
                [
                    {
                        commitId: 'commit-555',
                        changeId: 'I55555',
                    },
                ],
                mockJjService,
            );

            expect(changed).toBe(true);
            const cached = provider.getCachedChangeInfo('I55555');
            expect(cached?.draftComments).toBe(0);
            expect(cached?.draftResponses).toBe(1);
            expect(cached?.addressedThreads).toBe(1);
            expect(cached?.hasDraftResponses).toBe(true);
        });

        test('deduplicates addressedThreads when multiple draft replies exist for the same thread', async () => {
            const changeNum = server.registerChange('I66666');
            server.registerComments(changeNum, {
                'file.txt': [
                    { id: 'c1', line: 5, message: 'Comment 1', updated: '2026-06-30T12:00:00Z', unresolved: true },
                    { id: 'c2', line: 10, message: 'Comment 2', updated: '2026-06-30T12:00:00Z', unresolved: true },
                ],
            });
            // Two drafts replying to the SAME comment thread 'c1'
            server.registerDrafts(changeNum, {
                'file.txt': [
                    { id: 'd1', in_reply_to: 'c1', line: 5, message: 'Part 1', updated: '2026-06-30T12:01:00Z' },
                    { id: 'd2', in_reply_to: 'c1', line: 5, message: 'Part 2', updated: '2026-06-30T12:02:00Z' },
                    // One top-level draft comment
                    { id: 'd3', line: 15, message: 'Top-level draft', updated: '2026-06-30T12:03:00Z' },
                ],
            });

            const changed = await provider.fetchStatuses(
                [{ commitId: 'commit-666', changeId: 'I66666' }],
                mockJjService,
            );

            expect(changed).toBe(true);
            const cached = provider.getCachedChangeInfo('I66666');
            expect(cached?.draftComments).toBe(1); // 1 top-level draft
            expect(cached?.draftResponses).toBe(2); // 2 draft replies total
            expect(cached?.addressedThreads).toBe(1); // but only 1 unique thread addressed!
            expect(cached?.hasDraftResponses).toBe(true);
        });

        test('updating an existing draft replaces it in cache rather than dropping the update', () => {
            const recordDraft = exposePrivate<{
                recordDraftComment(
                    changeNumber: number,
                    draft: { id: string; in_reply_to?: string; line?: number; message?: string },
                    filePath: string,
                ): void;
            }>(provider).recordDraftComment.bind(provider);

            // Populate change cache first
            const cache = accessPrivate<LruCache<string, CodeForgeChangeInfo>>(provider, 'cache');
            cache.set('I12345', {
                id: 'I12345',
                number: 123,
                displayLabel: 'CL/123',
                providerName: 'Gerrit',
                status: 'NEW',
                submittable: true,
                unresolvedComments: 1,
                url: 'url',
                currentRevision: 'sha-1',
            });

            // Initial draft
            recordDraft(123, { id: 'd1', in_reply_to: 'c1', line: 5, message: 'Initial draft text' }, 'file.txt');
            let cached = provider.getCachedChangeInfo('I12345');
            expect(cached?.draftResponses).toBe(1);
            expect(cached?.addressedThreads).toBe(1);

            // Updating the existing draft (same id) replaces it instead of creating duplicates
            recordDraft(123, { id: 'd1', in_reply_to: 'c1', line: 5, message: 'Updated draft text' }, 'file.txt');
            cached = provider.getCachedChangeInfo('I12345');
            expect(cached?.draftResponses).toBe(1);
            expect(cached?.addressedThreads).toBe(1);

            const draftsCache = accessPrivate<AsyncCache<number, Record<string, { id: string; message?: string }[]>>>(
                provider,
                'draftsCache',
            );
            const draftsMap = draftsCache.peek(123);
            expect(draftsMap?.['file.txt']).toHaveLength(1);
            expect(draftsMap?.['file.txt']?.[0].message).toBe('Updated draft text');

            // When commentsCache has expired, recordDraftComment does not revive it
            const commentsCache = accessPrivate<AsyncCache<number, unknown>>(provider, 'commentsCache');
            const commentsInternal = accessPrivate<LruCache<number, { expires: number }>>(commentsCache, '_cache');
            commentsCache.set(123, { 'file.txt': [] });
            const commentsEntry = commentsInternal.get(123);
            if (commentsEntry) {
                commentsEntry.expires = 0; // Expire commentsCache
            }

            // Record draft
            recordDraft(123, { id: 'd2', in_reply_to: 'c2', line: 10, message: 'New draft' }, 'file.txt');

            // commentsCache should NOT have been revived (peek returns undefined because expired)
            expect(commentsCache.peek(123)).toBeUndefined();
        });

        test('network error in fetchDraftsFromNetwork does not poison cache with empty draft state', async () => {
            const changeNum = server.registerChange('I77777');
            server.registerDrafts(changeNum, {
                'file.txt': [
                    { id: 'd1', in_reply_to: 'c1', line: 5, message: 'Reply', updated: '2026-06-30T12:01:00Z' },
                ],
            });

            // Initial successful fetch
            await provider.fetchStatuses([{ commitId: 'commit-777', changeId: 'I77777' }], mockJjService);
            const initial = provider.getCachedChangeInfo('I77777');
            expect(initial?.draftResponses).toBe(1);
            expect(initial?.addressedThreads).toBe(1);

            // Expire drafts cache TTL so next fetch would re-query drafts
            const draftsCache = accessPrivate<AsyncCache<number, unknown>>(provider, 'draftsCache');
            const internalCache = accessPrivate<LruCache<number, { expires: number }>>(draftsCache, '_cache');
            const entry = internalCache.get(changeNum);
            if (entry) {
                entry.expires = 0;
            }

            // Simulate drafts endpoint failure
            server.failDraftsWithStatus = 500;

            // Fetch should gracefully preserve existing cached draft metrics rather than poisoning with 0
            await provider.fetchStatuses([{ commitId: 'commit-777', changeId: 'I77777' }], mockJjService);
            const afterError = provider.getCachedChangeInfo('I77777');
            expect(afterError?.draftResponses).toBe(1);
            expect(afterError?.addressedThreads).toBe(1);

            // When cache is empty and network fails, cache is not poisoned with empty entry
            provider.clearCache();
            await provider.fetchStatuses([{ commitId: 'commit-777', changeId: 'I77777' }], mockJjService);
            const emptyCacheEntry = draftsCache.peekStale(changeNum);
            expect(emptyCacheEntry).toBeUndefined();
        });

        test('fetchStatuses tolerates individual change draft fetch errors without failing entire batch', async () => {
            server.registerChange('I11111');
            server.registerChange('I22222');

            // Simulate drafts endpoint failure for change 1, but change 2 succeeds
            server.failDraftsWithStatus = 500;

            const changed = await provider.fetchStatuses(
                [
                    { commitId: 'c1', changeId: 'I11111' },
                    { commitId: 'c2', changeId: 'I22222' },
                ],
                mockJjService,
            );

            expect(changed).toBe(true);
            const cached1 = provider.getCachedChangeInfo('I11111');
            const cached2 = provider.getCachedChangeInfo('I22222');
            expect(cached1).toBeDefined();
            expect(cached2).toBeDefined();
        });

        test('dispose calls clearCache and empties all caches', () => {
            provider.clearCache();
            const cache = accessPrivate<LruCache<string, unknown>>(provider, 'cache');
            const draftsCache = accessPrivate<AsyncCache<number, unknown>>(provider, 'draftsCache');
            cache.set('key', { id: 'test' });
            draftsCache.set(1, {});

            expect(cache.size).toBe(1);
            expect(draftsCache.size).toBe(1);

            provider.dispose();

            expect(cache.size).toBe(0);
            expect(draftsCache.size).toBe(0);
        });

        test('draftsCache evicts least recently used entries when capacity exceeds maxEntries', () => {
            const draftsCache = accessPrivate<AsyncCache<number, unknown>>(provider, 'draftsCache');

            expect(draftsCache.maxEntries).toBe(150);
            for (let i = 1; i <= 155; i++) {
                draftsCache.set(i, {});
            }
            expect(draftsCache.size).toBe(150);
            // Oldest entries 1..5 should be evicted
            expect(draftsCache.peek(1)).toBeUndefined();
            expect(draftsCache.peek(5)).toBeUndefined();
            expect(draftsCache.peek(6)).toBeDefined();
            expect(draftsCache.peek(155)).toBeDefined();
        });
    });
});
