/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// sort-imports-ignore

import { beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

import {
    ackCommentCommand,
    doneCommentCommand,
    replyAndResolveCommentCommand,
    replyCommentCommand,
} from '../commands/comments';
import type { CommentsManager } from '../comments-manager';
import { createMock } from './test-utils';

describe('Comment Command Handlers', () => {
    let mockCommentsManager: CommentsManager;
    let replyToThreadSpy: Mock;
    let toggleResolveThreadSpy: Mock;

    beforeEach(() => {
        vi.clearAllMocks();

        // Create spies
        replyToThreadSpy = vi.fn().mockResolvedValue(undefined);
        toggleResolveThreadSpy = vi.fn().mockResolvedValue(undefined);

        mockCommentsManager = createMock<CommentsManager>({
            replyToThread: replyToThreadSpy,
            toggleResolveThread: toggleResolveThreadSpy,
        });
    });

    test('replyCommentCommand delegates to replyToThread without resolving', async () => {
        const mockThread = createMock<vscode.CommentThread>();
        const reply = createMock<vscode.CommentReply>({
            thread: mockThread,
            text: 'my response',
        });

        await replyCommentCommand(mockCommentsManager, reply);

        expect(replyToThreadSpy).toHaveBeenCalledWith(reply);
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });

    test('ackCommentCommand sends Acknowledged comment and resolves the thread', async () => {
        const mockThread = createMock<vscode.CommentThread>();
        const reply = createMock<vscode.CommentReply>({
            thread: mockThread,
            text: 'some random typed text',
        });

        await ackCommentCommand(mockCommentsManager, reply);

        expect(replyToThreadSpy).toHaveBeenCalledWith(
            {
                thread: mockThread,
                text: 'Acknowledged',
            },
            true,
        );
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });

    test('doneCommentCommand sends Done comment and resolves the thread', async () => {
        const mockThread = createMock<vscode.CommentThread>();
        const reply = createMock<vscode.CommentReply>({
            thread: mockThread,
            text: 'some random typed text',
        });

        await doneCommentCommand(mockCommentsManager, reply);

        expect(replyToThreadSpy).toHaveBeenCalledWith(
            {
                thread: mockThread,
                text: 'Done',
            },
            true,
        );
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });

    test('replyAndResolveCommentCommand sends typed text and resolves the thread', async () => {
        const mockThread = createMock<vscode.CommentThread>();
        const reply = createMock<vscode.CommentReply>({
            thread: mockThread,
            text: 'my typed response',
        });

        await replyAndResolveCommentCommand(mockCommentsManager, reply);

        expect(replyToThreadSpy).toHaveBeenCalledWith(reply, true);
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });

    test('command handlers return early if reply is falsy', async () => {
        await replyCommentCommand(mockCommentsManager, undefined);
        await ackCommentCommand(mockCommentsManager, undefined);
        await doneCommentCommand(mockCommentsManager, undefined);
        await replyAndResolveCommentCommand(mockCommentsManager, undefined);

        expect(replyToThreadSpy).not.toHaveBeenCalled();
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });
});
