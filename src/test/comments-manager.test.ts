/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { Uri } from '../uri-utils';
// sort-imports-ignore

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

import type { CodeForgeComment, CodeForgeCommentThread, CodeForgeProvider } from '../code-forge-provider';
import { CodeForgeRegistry } from '../code-forge-registry';
import { CommentsManager, type CommentThread } from '../comments-manager';
import { JjRepositoryManager } from '../jj-repository-manager';
import type { CodeForgeChangeInfo } from '../jj-types';
import { VsCodeCommentsProvider } from '../vscode/providers/vscode-comments-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { accessPrivate, CallbackWaiter, createMock, createMockLogOutputChannel, setPrivate } from './test-utils';

class MockCommentsProvider implements CodeForgeProvider {
    readonly id = 'mock-provider';
    readonly displayName = 'Mock';
    readonly changeTerm = 'PR';
    readonly onDidUpdate = new vscode.EventEmitter<void>().event;

    public lastRequestedChangeId?: string;
    public commentThreadsWaiter?: CallbackWaiter<string>;

    createCommentThreadsWaiter(): CallbackWaiter<string> {
        const waiter = new CallbackWaiter<string>();
        this.commentThreadsWaiter = waiter;
        return waiter;
    }

    getCachedChangeInfo(changeId?: string, description?: string) {
        if (description?.includes('no-change')) {
            return undefined;
        }
        return {
            id: changeId || 'change-123',
            number: 123,
            displayLabel: 'PR #123',
            providerName: 'Mock',
            status: 'NEW' as const,
            submittable: true,
            unresolvedComments: 0,
            url: 'url',
        };
    }

    async fetchStatuses(): Promise<boolean> {
        return false;
    }

    private threads: CodeForgeCommentThread[] = [];

    setThreads(threads: CodeForgeCommentThread[]) {
        this.threads = threads;
    }

    async detect(): Promise<boolean> {
        return true;
    }

    async getCommentThreads(changeId: string): Promise<CodeForgeCommentThread[]> {
        this.lastRequestedChangeId = changeId;
        this.commentThreadsWaiter?.recordCall(changeId);
        return this.threads;
    }

    async replyToCommentThread(
        _changeId: string,
        threadId: string,
        body: string,
        resolved?: boolean,
    ): Promise<CodeForgeComment> {
        const reply: CodeForgeComment = {
            id: 'new-reply',
            author: { name: 'Replier' },
            body,
            createdAt: new Date().toISOString(),
        };
        const thread = this.threads.find((t) => t.id === threadId);
        if (thread) {
            thread.comments.push(reply);
            if (resolved !== undefined) {
                thread.isResolved = resolved;
            }
        }
        return reply;
    }

    async resolveCommentThread(_changeId: string, threadId: string, resolved: boolean): Promise<void> {
        const thread = this.threads.find((t) => t.id === threadId);
        if (thread) {
            thread.isResolved = resolved;
        }
    }

    clearCache() {}
    activate() {}
    deactivate() {}
}

describe('CommentsManager Tests', () => {
    let repositoryManager: JjRepositoryManager;
    let commentsManager: CommentsManager;
    let commentsProvider: VsCodeCommentsProvider;
    let provider: MockCommentsProvider;
    let testRepo: TestRepo;
    let fakeHost: FakeHostEnvironment;

    beforeEach(async () => {
        vi.clearAllMocks();

        testRepo = new TestRepo();
        testRepo.init();

        fakeHost = new FakeHostEnvironment();

        provider = new MockCommentsProvider();
        const registry = new CodeForgeRegistry();
        registry.register({
            id: 'mock-provider',
            create: () => provider,
        });

        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });

        fakeHost.workspace.addFolder(Uri.file(testRepo.path));
        repositoryManager = new JjRepositoryManager(registry, outputChannel, fakeHost);

        // Register the real repository
        const realRepo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        repositoryManager.tryAutoSwitch(Uri.file(testRepo.path));

        if (realRepo) {
            await realRepo.codeForge.detectActiveProvider(true);
        }

        commentsManager = new CommentsManager(repositoryManager, fakeHost);
        commentsProvider = new VsCodeCommentsProvider(commentsManager);
    });

    afterEach(async () => {
        commentsProvider.dispose();
        commentsManager.dispose();
        await repositoryManager.dispose();
    });

    test('showCommentsForChange should fetch and render comment threads', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-1',
                filePath: 'file.txt',
                line: 10,
                isResolved: false,
                comments: [
                    {
                        id: 'comment-1',
                        author: { name: 'Author A', avatarUrl: 'https://example.com/avatar.png' },
                        body: 'This is a comment',
                        createdAt: '2026-06-30T12:00:00Z',
                    },
                ],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        expect(commentsManager.threads).toHaveLength(1);
        expect(commentsManager.threads[0].id).toBe('thread-1');
        expect(commentsProvider.getThreads().size).toBe(1);
    });

    test('onDidChangeThreads event fires when comments are updated', async () => {
        const received: CodeForgeCommentThread[][] = [];
        commentsManager.onDidChangeThreads((t) => received.push(t));

        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-event-test',
                filePath: 'file.txt',
                line: 5,
                isResolved: false,
                comments: [],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        expect(received.length).toBeGreaterThan(0);
        const last = received[received.length - 1];
        expect(last).toHaveLength(1);
        expect(last[0].id).toBe('thread-event-test');
    });

    test('replyToThread should post a reply and refresh', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-1',
                filePath: 'file.txt',
                line: 10,
                isResolved: false,
                comments: [],
            },
        ];
        provider.setThreads(threads);

        // Fetch initial thread so commentsManager has it cached
        await commentsManager.showCommentsForChange('@');

        // Retrieve created thread from mock
        const mockController = (vscode.comments.createCommentController as ReturnType<typeof vi.fn>).mock.results[0]
            .value;
        const createdThread = mockController.createCommentThread.mock.results[0].value;
        createdThread.canReply = true;

        await commentsManager.replyToThread({
            thread: { id: 'thread-1', uri: Uri.file(path.join(testRepo.path, 'file.txt')) },
            text: 'Here is my reply',
        });

        expect(threads[0].comments.length).toBe(1);
        expect(threads[0].comments[0].body).toBe('Here is my reply');
    });

    test('replyToThread should correctly disambiguate multiple threads on the same line by thread ID', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-1',
                filePath: 'file.txt',
                line: 10,
                isResolved: false,
                comments: [],
            },
            {
                id: 'thread-2',
                filePath: 'file.txt',
                line: 10,
                isResolved: false,
                comments: [],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        await commentsManager.replyToThread({
            thread: { id: 'thread-2', uri: Uri.file(path.join(testRepo.path, 'file.txt')) },
            text: 'Reply to thread 2',
        });

        expect(threads[0].comments.length).toBe(0);
        expect(threads[1].comments.length).toBe(1);
        expect(threads[1].comments[0].body).toBe('Reply to thread 2');
    });

    test('toggleResolveThread should toggle resolved status and refresh', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-1',
                filePath: 'file.txt',
                line: 10,
                isResolved: false,
                comments: [],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        const mockController = (vscode.comments.createCommentController as ReturnType<typeof vi.fn>).mock.results[0]
            .value;
        const createdThread = mockController.createCommentThread.mock.results[0].value;

        // Resolve the thread
        await commentsManager.toggleResolveThread(
            { id: 'thread-1', uri: Uri.file(path.join(testRepo.path, 'file.txt')) },
            true,
        );

        // Underlying model updated
        expect(threads[0].isResolved).toBe(true);

        // VS Code thread UX updated for resolved state
        expect(createdThread.contextValue).toBe('resolved:thread-1');
        expect(createdThread.state).toBe(vscode.CommentThreadState.Resolved);
        expect(createdThread.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Collapsed);

        // Unresolve the thread
        await commentsManager.toggleResolveThread(
            { id: 'thread-1', uri: Uri.file(path.join(testRepo.path, 'file.txt')) },
            false,
        );

        // Underlying model updated
        expect(threads[0].isResolved).toBe(false);

        // VS Code thread UX updated for unresolved state
        expect(createdThread.contextValue).toBe('unresolved:thread-1');
        expect(createdThread.state).toBe(vscode.CommentThreadState.Unresolved);
        expect(createdThread.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Expanded);
    });

    test('should safeguard invalid or 0 line numbers', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-0',
                filePath: 'file.txt',
                line: 0, // Invalid line number (should resolve to 0 in vscode instead of throwing)
                isResolved: false,
                comments: [],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        const mockController = (vscode.comments.createCommentController as ReturnType<typeof vi.fn>).mock.results[0]
            .value;
        const createdThread = mockController.createCommentThread.mock.results[0].value;
        expect(createdThread.range.start.line).toBe(0);
    });

    test('should update thread range when line changes', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-1',
                filePath: 'file.txt',
                line: 10,
                isResolved: false,
                comments: [],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        const mockController = (vscode.comments.createCommentController as ReturnType<typeof vi.fn>).mock.results[0]
            .value;
        const createdThread = mockController.createCommentThread.mock.results[0].value;
        expect(createdThread.range.start.line).toBe(9);

        // Update line number for the same thread and refresh
        threads[0].line = 15;
        await commentsManager.showCommentsForChange('@');

        expect(createdThread.range.start.line).toBe(14);
    });

    test('should clear explicitChangeId and target new working copy when working copy changes', async () => {
        commentsProvider.dispose();
        commentsManager.dispose();

        const ids = await buildGraph(testRepo, [
            { label: 'c1', description: 'first commit' },
            { label: 'c2', description: 'second commit' },
        ]);

        const c1ChangeId = ids.c1.changeId;

        // Get the waiter once early in the test
        const pullWaiter = provider.createCommentThreadsWaiter();

        // Construct the manager (triggers initial pull targeting '@')
        commentsManager = new CommentsManager(repositoryManager, fakeHost);
        commentsProvider = new VsCodeCommentsProvider(commentsManager);

        const workingCopyLog1 = await repositoryManager.focusedRepository?.jj.getLog({ revision: '@' });
        const workingCopyChangeId1 = workingCopyLog1?.[0]?.change_id;
        expect(await pullWaiter.waitNext()).toBe(workingCopyChangeId1);

        // Explicitly target c1 (parent)
        await commentsManager.showCommentsForChange(c1ChangeId);
        expect(await pullWaiter.waitNext()).toBe(c1ChangeId);

        // Access internal field to confirm explicitChangeId is set to c1ChangeId
        expect(accessPrivate<string | undefined>(commentsManager, 'explicitChangeId')).toBe(c1ChangeId);

        // Trigger an SCM/repo refresh (with the same working copy)
        await repositoryManager.focusedRepository?.refresh();
        expect(await pullWaiter.waitNext()).toBe(c1ChangeId);
        expect(accessPrivate<string | undefined>(commentsManager, 'explicitChangeId')).toBe(c1ChangeId);

        // Now, change the working copy by creating a new commit on top of c2
        testRepo.new();

        // Wait for the automatic background pull to happen and target the new working copy
        const workingCopyLog2 = await repositoryManager.focusedRepository?.jj.getLog({ revision: '@' });
        const workingCopyChangeId2 = workingCopyLog2?.[0]?.change_id;
        expect(await pullWaiter.waitNext()).toBe(workingCopyChangeId2);

        // explicitChangeId should be cleared to undefined
        expect(accessPrivate<string | undefined>(commentsManager, 'explicitChangeId')).toBeUndefined();
    });

    test('should target @- when @ has no associated change', async () => {
        commentsProvider.dispose();
        commentsManager.dispose();

        // Build c1 (parent, normal commit) and c2 (working copy, with 'no-change' in description)
        const ids = await buildGraph(testRepo, [
            { label: 'c1', description: 'Normal parent commit with comments' },
            { label: 'c2', parents: ['c1'], description: 'Working copy with no-change' },
        ]);

        // Get the waiter once early
        const pullWaiter = provider.createCommentThreadsWaiter();
        commentsManager = new CommentsManager(repositoryManager, fakeHost);
        commentsProvider = new VsCodeCommentsProvider(commentsManager);

        // Wait for the automatic background pull to happen and target the parent c1
        expect(await pullWaiter.waitNext()).toBe(ids.c1.changeId);
    });

    test('should safely handle malformed avatar URLs in provider', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-1',
                filePath: 'file.txt',
                line: 10,
                isResolved: false,
                comments: [
                    {
                        id: 'comment-1',
                        author: { name: 'Author A', avatarUrl: 'invalid::url\\foo' },
                        body: 'Malformed URL test',
                        createdAt: '2026-06-30T12:00:00Z',
                    },
                ],
            },
        ];
        provider.setThreads(threads);

        const parseSpy = vi.spyOn(Uri, 'parse').mockImplementationOnce(() => {
            throw new Error('Invalid URI');
        });

        await commentsManager.showCommentsForChange('@');

        const mockController = (vscode.comments.createCommentController as ReturnType<typeof vi.fn>).mock.results[0]
            .value;
        const createdThread = mockController.createCommentThread.mock.results[0].value;
        expect(createdThread.comments[0].author.iconPath).toBeUndefined();

        parseSpy.mockRestore();
    });

    test('should not reset explicitChangeId on first run of pullCommentsAutomatically', async () => {
        setPrivate(commentsManager, 'explicitChangeId', 'some-change-id');
        setPrivate(commentsManager, 'lastWorkingCopyId', undefined);

        await commentsManager.pullCommentsAutomatically();

        expect(accessPrivate<string | undefined>(commentsManager, 'explicitChangeId')).toBe('some-change-id');
    });

    test('resolveChangeInfo correctly resolves change info when bookmarks array is empty', async () => {
        const repo = repositoryManager.focusedRepository;
        expect(repo).toBeDefined();
        if (!repo) {
            return;
        }

        const resolveFn = accessPrivate<
            (
                repo: unknown,
                provider: unknown,
                revision: string,
                logEntry?: unknown,
            ) => Promise<CodeForgeChangeInfo | undefined>
        >(commentsManager, 'resolveChangeInfo');

        const changeInfo = await resolveFn.call(commentsManager, repo, provider, '@', {
            change_id: 'change-no-bookmarks',
            description: 'Test commit',
            bookmarks: [],
        });

        expect(changeInfo).toBeDefined();
        expect(changeInfo?.id).toBe('change-no-bookmarks');
    });

    test('formatUnresolvedComments and copyUnresolvedComments format markdown correctly', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-1',
                filePath: 'file.txt',
                line: 10,
                isResolved: false,
                comments: [
                    {
                        id: 'comment-1',
                        author: { name: 'Author A' },
                        body: 'This is unresolved',
                        createdAt: '2026-06-30T12:00:00Z',
                    },
                    {
                        id: 'comment-2',
                        author: { name: 'Author B' },
                        body: 'Replying to unresolved',
                        createdAt: '2026-06-30T12:05:00Z',
                    },
                ],
            },
            {
                id: 'thread-2',
                filePath: 'other.txt',
                line: 5,
                isResolved: true,
                comments: [
                    {
                        id: 'comment-3',
                        author: { name: 'Author C' },
                        body: 'This is resolved',
                        createdAt: '2026-06-30T12:00:00Z',
                    },
                ],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        const text = commentsManager.formatUnresolvedComments();
        expect(text).toContain('### Unresolved Comments for PR #123');
        expect(text).toContain('- **file.txt:10**');
        expect(text).toContain('  - **Author A**:');
        expect(text).toContain('    > This is unresolved');
        expect(text).toContain('  - **Author B**:');
        expect(text).toContain('    > Replying to unresolved');
        expect(text).not.toContain('other.txt:5');
    });

    test('formatUnresolvedComments handles threads with missing line numbers', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-1',
                filePath: 'file.txt',
                line: 0,
                isResolved: false,
                comments: [
                    {
                        id: 'comment-1',
                        author: { name: 'Author A' },
                        body: 'File-level comment',
                        createdAt: '2026-06-30T12:00:00Z',
                    },
                ],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        const text = commentsManager.formatUnresolvedComments();
        expect(text).toContain('### Unresolved Comments for PR #123');
        expect(text).toContain('- **file.txt**');
        expect(text).not.toContain('file.txt:0');
    });

    test('formatUnresolvedComments sorts threads by file path and line number, with author fallback', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-line-15',
                filePath: 'file.txt',
                line: 15,
                isResolved: false,
                comments: [
                    {
                        id: 'comment-1',
                        author: { name: '' },
                        body: 'Second comment in file.txt',
                        createdAt: '2026-06-30T12:00:00Z',
                    },
                ],
            },
            {
                id: 'thread-file-b',
                filePath: 'another.txt',
                line: 5,
                isResolved: false,
                comments: [
                    {
                        id: 'comment-2',
                        author: { name: 'Author B' },
                        body: 'Comment in another.txt',
                        createdAt: '2026-06-30T12:00:00Z',
                    },
                ],
            },
            {
                id: 'thread-line-10',
                filePath: 'file.txt',
                line: 10,
                isResolved: false,
                comments: [
                    createMock<CodeForgeComment>({
                        id: 'comment-3',
                        body: 'First comment in file.txt',
                        createdAt: '2026-06-30T12:00:00Z',
                    }),
                ],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        const text = commentsManager.formatUnresolvedComments() ?? '';
        expect(text).not.toBe('');

        const indexAnother = text.indexOf('another.txt:5');
        const indexFile10 = text.indexOf('file.txt:10');
        const indexFile15 = text.indexOf('file.txt:15');

        expect(indexAnother).toBeLessThan(indexFile10);
        expect(indexFile10).toBeLessThan(indexFile15);

        expect(text).toContain('  - **Unknown**:\n    > First comment in file.txt');
        expect(text).toContain('  - **Unknown**:\n    > Second comment in file.txt');
    });

    test('replyToThread and toggleResolveThread handle file-level comments (line: 0)', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-file-0',
                filePath: 'file.txt',
                line: 0,
                isResolved: false,
                comments: [],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        const fileUri = Uri.file(path.join(testRepo.path, 'file.txt'));

        await commentsManager.replyToThread({
            thread: { id: 'thread-file-0', uri: fileUri, range },
            text: 'Reply to file-level comment',
        });

        expect(threads[0].comments.length).toBe(1);
        expect(threads[0].comments[0].body).toBe('Reply to file-level comment');

        await commentsManager.toggleResolveThread({ id: 'thread-file-0', uri: fileUri, range }, true);
        expect(threads[0].isResolved).toBe(true);
    });

    test('copyUnresolvedComments writes to HostNavigation clipboard and informs HostUi', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-host-test',
                filePath: 'file.txt',
                line: 5,
                isResolved: false,
                comments: [
                    {
                        id: 'comment-1',
                        author: { name: 'Alice' },
                        body: 'Fix this line',
                        createdAt: '2026-06-30T12:00:00Z',
                    },
                ],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');
        await commentsManager.copyUnresolvedComments();

        expect(fakeHost.nav.clipboardText).toContain('### Unresolved Comments for PR #123');
        expect(fakeHost.nav.clipboardText).toContain('- **file.txt:5**');
        expect(fakeHost.nav.clipboardText).toContain('> Fix this line');
        expect(fakeHost.ui.infoMessages).toContain('Copied 1 unresolved comment(s) to clipboard.');
    });

    test('replyToThread tracks progress via HostEnvironment withProgress', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-progress',
                filePath: 'file.txt',
                line: 1,
                isResolved: false,
                comments: [],
            },
        ];
        provider.setThreads(threads);
        await commentsManager.showCommentsForChange('@');

        const thread: CommentThread = {
            id: 'thread-progress',
            uri: Uri.file(path.join(testRepo.path, 'file.txt')),
        };
        await commentsManager.replyToThread({ thread, text: 'Test reply' });

        expect(fakeHost.ui.progressTitles).toContain('Sending reply...');
        expect(threads[0].comments).toHaveLength(1);
    });
});
