/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ChangeStatusRequest } from '../code-forge-provider';
import { GerritProvider } from '../gerrit-provider';
import type { JjService } from '../jj-service';
import type { CodeForgeChangeInfo } from '../jj-types';
import { resolveGerritChangeKey, stripGerritTrailers } from '../utils/gerrit-utils';
import { FakeGerritServer } from './helpers/fake-gerrit-server';
import { accessPrivate, createMock, createMockLogOutputChannel, exposePrivate, setPrivate } from './test-utils';

// Mock VS Code
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: vi.fn(() => ({
            get: vi.fn(),
        })),
        onDidChangeConfiguration: vi.fn(),
    },
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

    beforeEach(() => {
        mockJjService = createMock<JjService>({});
        mockOutputChannel = createMockLogOutputChannel({ appendLine: vi.fn() });
        provider = new GerritProvider(mockOutputChannel);
    });

    test('detect trims and checks for blank gerrit.host setting', async () => {
        const getMock = vi.fn().mockReturnValue('   '); // whitespace only
        vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
            get: getMock,
            has: vi.fn(),
            update: vi.fn(),
            inspect: vi.fn(),
        } as unknown as vscode.WorkspaceConfiguration);

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

        // Mock workspace config to return undefined for gerrit.host
        vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
            get: (key: string) => {
                if (key === 'binaryPath') {
                    return 'jj';
                }
                return undefined;
            },
            has: vi.fn(),
            update: vi.fn(),
            inspect: vi.fn(),
        } as unknown as vscode.WorkspaceConfiguration);

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
        const cache = accessPrivate<Map<string, unknown>>(provider, 'cache');
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

    describe('Comments API', () => {
        let server: FakeGerritServer;

        beforeEach(async () => {
            server = new FakeGerritServer();
            await server.start();
            setPrivate(provider, 'gerritHost', server.url);

            // Populate cache
            const cache = accessPrivate<Map<string, CodeForgeChangeInfo>>(provider, 'cache');
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

            const reply = await provider.replyToCommentThread('I12345', 'comment-1', 'Thanks!');
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

            await provider.resolveCommentThread('I12345', 'comment-1', true);
            let threads = await provider.getCommentThreads('I12345');
            expect(threads[0].isResolved).toBe(true);

            await provider.resolveCommentThread('I12345', 'comment-1', false);
            threads = await provider.getCommentThreads('I12345');
            expect(threads[0].isResolved).toBe(false);
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
            const cache = accessPrivate<Map<string, CodeForgeChangeInfo>>(provider, 'cache');
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
    });
});
