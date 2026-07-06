/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// sort-imports-ignore

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

import type { CodeForgeComment, CodeForgeCommentThread, CodeForgeProvider } from '../code-forge-provider';
import { CodeForgeRegistry } from '../code-forge-registry';
import { CommentsManager } from '../comments-manager';
import { JjRepositoryManager } from '../jj-repository-manager';
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

    async replyToCommentThread(_changeId: string, threadId: string, body: string): Promise<CodeForgeComment> {
        const reply: CodeForgeComment = {
            id: 'new-reply',
            author: { name: 'Replier' },
            body,
            createdAt: new Date().toISOString(),
        };
        const thread = this.threads.find((t) => t.id === threadId);
        if (thread) {
            thread.comments.push(reply);
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
    let provider: MockCommentsProvider;
    let testRepo: TestRepo;

    beforeEach(async () => {
        vi.clearAllMocks();

        testRepo = new TestRepo();
        testRepo.init();

        provider = new MockCommentsProvider();
        const registry = new CodeForgeRegistry();
        registry.register({
            id: 'mock-provider',
            create: () => provider,
        });

        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const workspaceState = createMock<vscode.Memento>({
            get: vi.fn().mockReturnValue(undefined),
            update: vi.fn().mockResolvedValue(undefined),
        });

        repositoryManager = new JjRepositoryManager(registry, outputChannel, workspaceState);

        // Register the real repository
        vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {
            uri: vscode.Uri.file(testRepo.path),
        });
        const realRepo = await repositoryManager.maybeRegisterRepositoryContainingUri(vscode.Uri.file(testRepo.path));
        repositoryManager.tryAutoSwitch(vscode.Uri.file(testRepo.path));

        if (realRepo) {
            await realRepo.codeForge.detectActiveProvider(true);
        }

        commentsManager = new CommentsManager(repositoryManager);
    });

    afterEach(async () => {
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

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.focusCommentsPanel');
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

        const reply = createMock<vscode.CommentReply>({
            thread: createdThread,
            text: 'Here is my reply',
        });

        await commentsManager.replyToThread(reply);

        expect(threads[0].comments.length).toBe(1);
        expect(threads[0].comments[0].body).toBe('Here is my reply');
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
        await commentsManager.toggleResolveThread(createdThread, true);

        // Underlying model updated
        expect(threads[0].isResolved).toBe(true);

        // VS Code thread UX updated for resolved state
        expect(createdThread.contextValue).toBe('resolved');
        expect(createdThread.state).toBe(vscode.CommentThreadState.Resolved);
        expect(createdThread.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Collapsed);

        // Unresolve the thread
        await commentsManager.toggleResolveThread(createdThread, false);

        // Underlying model updated
        expect(threads[0].isResolved).toBe(false);

        // VS Code thread UX updated for unresolved state
        expect(createdThread.contextValue).toBe('unresolved');
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
        // Dispose of the default manager to avoid background watch event interference during graph construction
        commentsManager.dispose();

        const ids = await buildGraph(testRepo, [
            { label: 'c1', description: 'first commit' },
            { label: 'c2', description: 'second commit' },
        ]);

        const c1ChangeId = ids.c1.changeId;

        // Get the waiter once early in the test
        const pullWaiter = provider.createCommentThreadsWaiter();

        // Construct the manager (triggers initial pull targeting '@')
        commentsManager = new CommentsManager(repositoryManager);

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
        // Dispose of the default manager to avoid background watch event interference during graph construction
        commentsManager.dispose();

        // Build c1 (parent, normal commit) and c2 (working copy, with 'no-change' in description)
        const ids = await buildGraph(testRepo, [
            { label: 'c1', description: 'Normal parent commit with comments' },
            { label: 'c2', parents: ['c1'], description: 'Working copy with no-change' },
        ]);

        // Get the waiter once early
        const pullWaiter = provider.createCommentThreadsWaiter();
        commentsManager = new CommentsManager(repositoryManager);

        // Wait for the automatic background pull to happen and target the parent c1
        expect(await pullWaiter.waitNext()).toBe(ids.c1.changeId);
    });

    test('should safely handle malformed avatar URLs', async () => {
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

        const parseSpy = vi.spyOn(vscode.Uri, 'parse').mockImplementationOnce(() => {
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
});
