/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

import type { CodeForgeComment, CodeForgeCommentThread, CodeForgeProvider } from '../../code-forge-provider';
import { CodeForgeRegistry } from '../../code-forge-registry';
import {
    ackCommentCommand,
    copyUnresolvedCommentsCommand,
    doneCommentCommand,
    replyAndResolveCommentCommand,
    replyCommentCommand,
    resolveCommentThreadCommand,
    showCommentsCommand,
    unresolveCommentThreadCommand,
} from '../../commands/comments';
import { CommentsManager } from '../../comments-manager';
import { JjRepositoryManager } from '../../jj-repository-manager';
import { Uri } from '../../uri-utils';
import {
    createReplyCommentPayload,
    createResolveCommentThreadPayload,
    createShowCommentsPayload,
} from '../../vscode/payloads/comments.payload';
import { FakeCommandContext, FakeHostEnvironment } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';

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
            unresolvedComments: this.threads.filter((t) => !t.isResolved).length,
            url: 'https://example.com/pr/123',
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
            id: `reply-${Date.now()}`,
            author: { name: 'Current User' },
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

describe('Comment Command Handlers with Real CommentsManager', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let commentsManager: CommentsManager;
    let mockForge: MockForgeProvider;
    let ctx: FakeCommandContext;
    let fileUri: Uri;
    const threadRange = { start: { line: 9, character: 0 }, end: { line: 9, character: 0 } };

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

        if (!realRepo) {
            throw new Error('Real repository could not be registered');
        }
        await realRepo.codeForge.detectActiveProvider(true);

        const host = new FakeHostEnvironment();
        commentsManager = new CommentsManager(repositoryManager, host);
        ctx = new FakeCommandContext(realRepo, host, undefined, commentsManager);

        fileUri = Uri.file(path.join(testRepo.path, 'file.txt'));
        mockForge.setThreads([
            {
                id: 'thread-1',
                filePath: 'file.txt',
                line: 10,
                isResolved: false,
                comments: [
                    {
                        id: 'comment-1',
                        author: { name: 'Alice' },
                        body: 'Initial comment',
                        createdAt: '2026-01-01T00:00:00Z',
                    },
                ],
            },
        ]);

        await commentsManager.showCommentsForChange('@');
    });

    afterEach(async () => {
        commentsManager.dispose();
        await repositoryManager.dispose();
    });

    test('replyCommentCommand posts reply without resolving thread', async () => {
        const reply = {
            thread: { id: 'thread-1', uri: fileUri, range: threadRange },
            text: 'Here is my reply',
        };

        await replyCommentCommand(ctx, { reply });

        const threads = await mockForge.getCommentThreads();
        expect(threads[0].comments).toHaveLength(2);
        expect(threads[0].comments[1].body).toBe('Here is my reply');
        expect(threads[0].isResolved).toBe(false);
        expect(ctx.host.ui.progressTitles).toContain('Sending reply...');
    });

    test('ackCommentCommand posts Acknowledged and resolves the thread', async () => {
        const reply = {
            thread: { id: 'thread-1', uri: fileUri, range: threadRange },
            text: 'Ignored typed text',
        };

        await ackCommentCommand(ctx, { reply });

        const threads = await mockForge.getCommentThreads();
        expect(threads[0].comments).toHaveLength(2);
        expect(threads[0].comments[1].body).toBe('Acknowledged');
        expect(threads[0].isResolved).toBe(true);
    });

    test('doneCommentCommand posts Done and resolves the thread', async () => {
        const reply = {
            thread: { id: 'thread-1', uri: fileUri, range: threadRange },
            text: 'Ignored typed text',
        };

        await doneCommentCommand(ctx, { reply });

        const threads = await mockForge.getCommentThreads();
        expect(threads[0].comments).toHaveLength(2);
        expect(threads[0].comments[1].body).toBe('Done');
        expect(threads[0].isResolved).toBe(true);
    });

    test('replyAndResolveCommentCommand posts custom text and resolves the thread', async () => {
        const reply = {
            thread: { id: 'thread-1', uri: fileUri, range: threadRange },
            text: 'Fixed in latest commit',
        };

        await replyAndResolveCommentCommand(ctx, { reply });

        const threads = await mockForge.getCommentThreads();
        expect(threads[0].comments).toHaveLength(2);
        expect(threads[0].comments[1].body).toBe('Fixed in latest commit');
        expect(threads[0].isResolved).toBe(true);
    });

    test('resolveCommentThreadCommand and unresolveCommentThreadCommand toggle resolved state', async () => {
        const thread = { id: 'thread-1', uri: fileUri, range: threadRange };

        await resolveCommentThreadCommand(ctx, { arg: thread });
        let threads = await mockForge.getCommentThreads();
        expect(threads[0].isResolved).toBe(true);
        expect(ctx.host.ui.progressTitles).toContain('Resolving thread...');

        await unresolveCommentThreadCommand(ctx, { arg: thread });
        threads = await mockForge.getCommentThreads();
        expect(threads[0].isResolved).toBe(false);
        expect(ctx.host.ui.progressTitles).toContain('Unresolving thread...');
    });

    test('copyUnresolvedCommentsCommand copies formatted comments to clipboard and shows info notification', async () => {
        await copyUnresolvedCommentsCommand(ctx);

        const expectedText =
            '### Unresolved Comments for PR #123\n\n' +
            '- **file.txt:10**\n' +
            '  - **Alice**:\n' +
            '    > Initial comment\n';

        expect(ctx.host.nav.clipboardText).toBe(expectedText);
        expect(ctx.host.ui.infoMessages).toContain('Copied 1 unresolved comment(s) to clipboard.');
    });

    test('command handlers return early when payload or argument is falsy', async () => {
        await replyCommentCommand(ctx, {});
        await ackCommentCommand(ctx, {});
        await doneCommentCommand(ctx, {});
        await replyAndResolveCommentCommand(ctx, {});
        await resolveCommentThreadCommand(ctx, undefined);
        await unresolveCommentThreadCommand(ctx, undefined);

        const threads = await mockForge.getCommentThreads();
        expect(threads[0].comments).toHaveLength(1);
        expect(threads[0].isResolved).toBe(false);
    });

    test('showCommentsCommand loads comments and executes focusCommentsPanel on host', async () => {
        const payload = createShowCommentsPayload(['@']);
        await showCommentsCommand(ctx, payload);

        expect(commentsManager.threads).toHaveLength(1);
        expect(ctx.host.commands.executedCommands).toContainEqual({
            commandId: 'workbench.action.focusCommentsPanel',
            args: [],
        });
    });

    test('resolveCommentThreadCommand and replyCommentCommand disambiguate multiple threads on same line via contextValue', async () => {
        mockForge.setThreads([
            {
                id: 'thread-line-10-a',
                filePath: 'file.txt',
                line: 10,
                isResolved: false,
                comments: [],
            },
            {
                id: 'thread-line-10-b',
                filePath: 'file.txt',
                line: 10,
                isResolved: false,
                comments: [],
            },
        ]);
        await commentsManager.showCommentsForChange('@');

        const mockVscodeThreadB = createMock<vscode.CommentThread>({
            uri: fileUri,
            contextValue: 'unresolved:thread-line-10-b',
            range: new vscode.Range(9, 0, 9, 0),
            comments: [],
        });

        // 1. Reply to thread B via createReplyCommentPayload
        const replyPayload = createReplyCommentPayload([
            {
                thread: mockVscodeThreadB,
                text: 'Targeted reply to thread B',
            },
        ]);
        await replyCommentCommand(ctx, replyPayload);

        let threads = await mockForge.getCommentThreads();
        expect(threads[0].comments).toHaveLength(0);
        expect(threads[1].comments).toHaveLength(1);
        expect(threads[1].comments[0].body).toBe('Targeted reply to thread B');

        // 2. Resolve thread B via createResolveCommentThreadPayload
        const resolvePayload = createResolveCommentThreadPayload([mockVscodeThreadB]);
        await resolveCommentThreadCommand(ctx, resolvePayload);

        threads = await mockForge.getCommentThreads();
        expect(threads[0].isResolved).toBe(false);
        expect(threads[1].isResolved).toBe(true);
    });

    test('createShowCommentsPayload extracts revision from object argument', () => {
        const payload = createShowCommentsPayload([{ changeId: 'custom-change-456' }]);
        expect(payload.changeId).toBe('custom-change-456');
    });

    test('resolveCommentThreadCommand handles thread objects with direct id property', async () => {
        const threadWithId = {
            ...createMock<vscode.CommentThread>({
                uri: fileUri,
                contextValue: undefined,
                range: new vscode.Range(9, 0, 9, 0),
                comments: [],
            }),
            id: 'thread-1',
        };

        const resolvePayload = createResolveCommentThreadPayload([threadWithId]);
        await resolveCommentThreadCommand(ctx, resolvePayload);

        const threads = await mockForge.getCommentThreads();
        expect(threads[0].isResolved).toBe(true);
    });

    test('showCommentsCommand returns early without focusing comments panel if commentsManager is missing', async () => {
        const emptyCtx = new FakeCommandContext(ctx.repo, new FakeHostEnvironment(), undefined, undefined);
        const payload = createShowCommentsPayload(['@']);
        await showCommentsCommand(emptyCtx, payload);

        expect(emptyCtx.host.commands.executedCommands).toHaveLength(0);
    });
});
