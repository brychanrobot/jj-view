/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
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
import { Uri } from '../uri-utils';
import { VsCodeCommentsProvider } from '../vscode/providers/vscode-comments-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

class MockForgeProvider implements CodeForgeProvider {
    readonly id = 'mock-forge';
    readonly displayName = 'Mock';
    readonly changeTerm = 'PR';
    readonly onDidUpdate = new vscode.EventEmitter<void>().event;

    private threads: CodeForgeCommentThread[] = [];

    setThreads(threads: CodeForgeCommentThread[]) {
        this.threads = threads;
    }

    async detect(): Promise<boolean> {
        return true;
    }

    getCachedChangeInfo(changeId?: string) {
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

    async getCommentThreads(): Promise<CodeForgeCommentThread[]> {
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

describe('VsCodeCommentsProvider Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let commentsManager: CommentsManager;
    let provider: VsCodeCommentsProvider;
    let mockForge: MockForgeProvider;

    beforeEach(async () => {
        vi.clearAllMocks();

        testRepo = new TestRepo();
        testRepo.init();

        mockForge = new MockForgeProvider();
        const registry = new CodeForgeRegistry();
        registry.register({
            id: 'mock-forge',
            create: () => mockForge,
        });

        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const workspaceState = createMock<vscode.Memento>({
            get: vi.fn().mockReturnValue(undefined),
            update: vi.fn().mockResolvedValue(undefined),
        });

        repositoryManager = new JjRepositoryManager(registry, outputChannel, workspaceState);

        vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {
            uri: Uri.file(testRepo.path),
        });
        const realRepo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        repositoryManager.tryAutoSwitch(Uri.file(testRepo.path));

        if (realRepo) {
            await realRepo.codeForge.detectActiveProvider(true);
        }

        commentsManager = new CommentsManager(repositoryManager, new FakeHostEnvironment());
        provider = new VsCodeCommentsProvider(commentsManager);
    });

    afterEach(async () => {
        provider.dispose();
        commentsManager.dispose();
        await repositoryManager.dispose();
    });

    test('initializes CommentController and sets commentingRangeProvider to undefined', () => {
        expect(vscode.comments.createCommentController).toHaveBeenCalledWith('jj-view.comments', 'JJ Comments');
        expect(provider.getThreads().size).toBe(0);
    });

    test('syncs incoming comment threads from CommentsManager to vscode.CommentThread', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-1',
                filePath: 'src/index.ts',
                line: 42,
                isResolved: false,
                comments: [
                    {
                        id: 'comment-1',
                        author: { name: 'Alice', avatarUrl: 'https://example.com/alice.png' },
                        body: 'Please check this line',
                        createdAt: '2026-01-01T00:00:00Z',
                    },
                ],
            },
        ];

        mockForge.setThreads(threads);
        await commentsManager.showCommentsForChange('@');

        const createdThreads = provider.getThreads();
        expect(createdThreads.size).toBe(1);
        const thread1 = createdThreads.get('thread-1');
        expect(thread1).toBeDefined();
        expect(thread1?.comments).toHaveLength(1);
        expect(thread1?.contextValue).toBe('unresolved:thread-1');
        expect(thread1?.range?.start.line).toBe(41);
        expect(thread1?.uri.fsPath).toBe(Uri.file(path.join(testRepo.path, 'src/index.ts')).fsPath);
    });

    test('correctly syncs file-level comments (line: 0)', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-file-level',
                filePath: 'README.md',
                line: 0,
                isResolved: false,
                comments: [
                    {
                        id: 'comment-file-1',
                        author: { name: 'Bob' },
                        body: 'General comment on file',
                        createdAt: '2026-01-01T00:00:00Z',
                    },
                ],
            },
        ];

        mockForge.setThreads(threads);
        await commentsManager.showCommentsForChange('@');

        const createdThreads = provider.getThreads();
        expect(createdThreads.size).toBe(1);
        const thread = createdThreads.get('thread-file-level');
        expect(thread).toBeDefined();
        expect(thread?.range?.start.line).toBe(0);
    });

    test('updates collapsibleState and contextValue when thread resolution changes', async () => {
        const initialThreads: CodeForgeCommentThread[] = [
            {
                id: 'thread-state-test',
                filePath: 'src/index.ts',
                line: 10,
                isResolved: false,
                comments: [],
            },
        ];

        mockForge.setThreads(initialThreads);
        await commentsManager.showCommentsForChange('@');

        const thread = provider.getThreads().get('thread-state-test');
        expect(thread).toBeDefined();
        expect(thread?.contextValue).toBe('unresolved:thread-state-test');
        expect(thread?.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Expanded);

        // Update thread to resolved and refresh
        initialThreads[0].isResolved = true;
        mockForge.setThreads([...initialThreads]);
        await commentsManager.showCommentsForChange('@');

        expect(thread?.contextValue).toBe('resolved:thread-state-test');
        expect(thread?.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Collapsed);
    });

    test('handles malformed avatar URLs gracefully without throwing', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-malformed-avatar',
                filePath: 'src/index.ts',
                line: 5,
                isResolved: false,
                comments: [
                    {
                        id: 'c-1',
                        author: { name: 'User', avatarUrl: 'invalid://://malformed' },
                        body: 'Hello',
                        createdAt: '2026-01-01T00:00:00Z',
                    },
                ],
            },
        ];

        mockForge.setThreads(threads);
        await expect(commentsManager.showCommentsForChange('@')).resolves.not.toThrow();

        const thread = provider.getThreads().get('thread-malformed-avatar');
        expect(thread?.comments).toHaveLength(1);
    });

    test('disposes removed threads when threadsList shrinks', async () => {
        const initialThreads: CodeForgeCommentThread[] = [
            { id: 't-1', filePath: 'a.ts', line: 1, isResolved: false, comments: [] },
            { id: 't-2', filePath: 'b.ts', line: 2, isResolved: false, comments: [] },
        ];

        mockForge.setThreads(initialThreads);
        await commentsManager.showCommentsForChange('@');
        expect(provider.getThreads().size).toBe(2);

        // Update with only t-1
        mockForge.setThreads([{ id: 't-1', filePath: 'a.ts', line: 1, isResolved: false, comments: [] }]);
        await commentsManager.showCommentsForChange('@');

        expect(provider.getThreads().size).toBe(1);
        expect(provider.getThreads().has('t-1')).toBe(true);
        expect(provider.getThreads().has('t-2')).toBe(false);
    });

    test('clears and disposes threads on provider dispose', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-1',
                filePath: 'src/index.ts',
                line: 10,
                isResolved: true,
                comments: [],
            },
        ];

        mockForge.setThreads(threads);
        await commentsManager.showCommentsForChange('@');
        expect(provider.getThreads().size).toBe(1);

        provider.dispose();
        expect(provider.getThreads().size).toBe(0);
    });

    test('performs initial sync on construction when comments are already loaded', async () => {
        const threads: CodeForgeCommentThread[] = [
            {
                id: 'thread-init-sync',
                filePath: 'src/init.ts',
                line: 3,
                isResolved: false,
                comments: [],
            },
        ];

        mockForge.setThreads(threads);
        await commentsManager.showCommentsForChange('@');

        // Create a new provider while manager already has threads loaded
        const freshProvider = new VsCodeCommentsProvider(commentsManager);
        expect(freshProvider.getThreads().size).toBe(1);
        expect(freshProvider.getThreads().has('thread-init-sync')).toBe(true);

        freshProvider.dispose();
    });
});
