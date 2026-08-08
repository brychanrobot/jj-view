/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
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
            uri: Uri.file(testRepo.path),
        });
        const realRepo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        repositoryManager.tryAutoSwitch(Uri.file(testRepo.path));

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

    test('copyUnresolvedComments should filter, format, and copy unresolved comments to the clipboard', async () => {
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

        // Fetch comments so they are loaded into commentsManager
        await commentsManager.showCommentsForChange('@');

        // Let's call copyUnresolvedComments
        await commentsManager.copyUnresolvedComments();

        // Check that writeText was called
        const writeTextMock = vscode.env.clipboard.writeText as import('vitest').Mock;
        expect(writeTextMock).toHaveBeenCalled();
        const copiedText = writeTextMock.mock.calls[0][0];

        expect(copiedText).toContain('### Unresolved Comments for PR #123');
        expect(copiedText).toContain('- **file.txt:10**');
        expect(copiedText).toContain('  - **Author A**:');
        expect(copiedText).toContain('    > This is unresolved');
        expect(copiedText).toContain('  - **Author B**:');
        expect(copiedText).toContain('    > Replying to unresolved');

        // It should NOT contain the resolved comment from thread-2
        expect(copiedText).not.toContain('other.txt:5');
        expect(copiedText).not.toContain('This is resolved');
    });

    test('copyUnresolvedComments should show message and not copy if there are no unresolved comments', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-1',
                filePath: 'file.txt',
                line: 10,
                isResolved: true,
                comments: [
                    {
                        id: 'comment-1',
                        author: { name: 'Author A' },
                        body: 'This is resolved',
                        createdAt: '2026-06-30T12:00:00Z',
                    },
                ],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        // Reset the clipboard mock
        const writeTextMock = vscode.env.clipboard.writeText as import('vitest').Mock;
        writeTextMock.mockClear();

        await commentsManager.copyUnresolvedComments();

        expect(writeTextMock).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            'No unresolved comments for the active change.',
        );
    });

    test('copyUnresolvedComments should handle range-less threads correctly', async () => {
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
                        body: 'File-level comment',
                        createdAt: '2026-06-30T12:00:00Z',
                    },
                ],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        // Force the mock range to be undefined to simulate range-less thread
        for (const thread of commentsManager.getThreads().values()) {
            Object.defineProperty(thread, 'range', { value: undefined });
        }

        const writeTextMock = vscode.env.clipboard.writeText as import('vitest').Mock;
        writeTextMock.mockClear();

        await commentsManager.copyUnresolvedComments();

        expect(writeTextMock).toHaveBeenCalled();
        const copiedText = writeTextMock.mock.calls[0][0];
        expect(copiedText).toContain('### Unresolved Comments for PR #123');
        expect(copiedText).toContain('- **file.txt**');
        expect(copiedText).not.toContain('file.txt:');
        expect(copiedText).toContain('  - **Author A**:');
        expect(copiedText).toContain('    > File-level comment');
    });

    test('copyUnresolvedComments should handle clipboard write failure and show error message', async () => {
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
                ],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        const writeTextMock = vscode.env.clipboard.writeText as import('vitest').Mock;
        writeTextMock.mockClear();
        writeTextMock.mockRejectedValueOnce(new Error('Clipboard write error'));

        const showErrorMessageMock = vscode.window.showErrorMessage as import('vitest').Mock;
        showErrorMessageMock.mockClear();

        await commentsManager.copyUnresolvedComments();

        expect(writeTextMock).toHaveBeenCalled();
        expect(showErrorMessageMock).toHaveBeenCalledWith(
            'Failed to copy comments to clipboard: Clipboard write error',
        );
    });

    test('copyUnresolvedComments should sort threads by file path and line number, and handle missing author name', async () => {
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
                        // simulated missing author object or name
                        body: 'First comment in file.txt',
                        createdAt: '2026-06-30T12:00:00Z',
                    }),
                ],
            },
        ];
        provider.setThreads(threads);

        await commentsManager.showCommentsForChange('@');

        const writeTextMock = vscode.env.clipboard.writeText as import('vitest').Mock;
        writeTextMock.mockClear();

        await commentsManager.copyUnresolvedComments();

        expect(writeTextMock).toHaveBeenCalled();
        const copiedText = writeTextMock.mock.calls[0][0];

        // Verify order: another.txt:5 -> file.txt:10 -> file.txt:15
        const indexAnother = copiedText.indexOf('another.txt:5');
        const indexFile10 = copiedText.indexOf('file.txt:10');
        const indexFile15 = copiedText.indexOf('file.txt:15');

        expect(indexAnother).toBeLessThan(indexFile10);
        expect(indexFile10).toBeLessThan(indexFile15);

        // Verify author fallbacks
        expect(copiedText).toContain('  - **Unknown**:\n    > First comment in file.txt');
        expect(copiedText).toContain('  - **Unknown**:\n    > Second comment in file.txt');
    });
});
