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
import type { JjRepository } from '../jj-repository';
import { Uri } from '../uri-utils';
import type { JjLoggerChannel } from '../utils/output-channel';
import {
    createAckCommentPayload,
    createDoneCommentPayload,
    createReplyAndResolveCommentPayload,
    createReplyCommentPayload,
} from '../vscode/payloads/comments.payload';
import { VSCodeCommandContext } from '../vscode/vscode-command-context';
import { createMock } from './test-utils';

describe('Comment Command Handlers', () => {
    let mockCommentsManager: CommentsManager;
    let replyToThreadSpy: Mock;
    let toggleResolveThreadSpy: Mock;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        vi.clearAllMocks();

        // Create spies
        replyToThreadSpy = vi.fn().mockResolvedValue(undefined);
        toggleResolveThreadSpy = vi.fn().mockResolvedValue(undefined);

        mockCommentsManager = createMock<CommentsManager>({
            replyToThread: replyToThreadSpy,
            toggleResolveThread: toggleResolveThreadSpy,
        });

        ctx = new VSCodeCommandContext(
            createMock<JjRepository>({}),
            createMock<JjLoggerChannel>({}),
            mockCommentsManager,
        );
    });

    test('replyCommentCommand delegates to replyToThread without resolving', async () => {
        const mockThread = createMock<vscode.CommentThread>({ uri: Uri.parse('file:///test.ts') });
        const reply = createMock<vscode.CommentReply>({
            thread: mockThread,
            text: 'my response',
        });

        const payload = createReplyCommentPayload([reply]);
        await replyCommentCommand(ctx, payload);

        expect(replyToThreadSpy).toHaveBeenCalledWith(payload.reply);
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });

    test('ackCommentCommand sends Acknowledged comment and resolves the thread', async () => {
        const mockThread = createMock<vscode.CommentThread>({ uri: Uri.parse('file:///test.ts') });
        const reply = createMock<vscode.CommentReply>({
            thread: mockThread,
            text: 'some random typed text',
        });

        const payload = createAckCommentPayload([reply]);
        await ackCommentCommand(ctx, payload);

        expect(replyToThreadSpy).toHaveBeenCalledWith(
            {
                thread: payload.reply?.thread,
                text: 'Acknowledged',
            },
            true,
        );
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });

    test('doneCommentCommand sends Done comment and resolves the thread', async () => {
        const mockThread = createMock<vscode.CommentThread>({ uri: Uri.parse('file:///test.ts') });
        const reply = createMock<vscode.CommentReply>({
            thread: mockThread,
            text: 'some random typed text',
        });

        const payload = createDoneCommentPayload([reply]);
        await doneCommentCommand(ctx, payload);

        expect(replyToThreadSpy).toHaveBeenCalledWith(
            {
                thread: payload.reply?.thread,
                text: 'Done',
            },
            true,
        );
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });

    test('replyAndResolveCommentCommand sends typed text and resolves the thread', async () => {
        const mockThread = createMock<vscode.CommentThread>({ uri: Uri.parse('file:///test.ts') });
        const reply = createMock<vscode.CommentReply>({
            thread: mockThread,
            text: 'my typed response',
        });

        const payload = createReplyAndResolveCommentPayload([reply]);
        await replyAndResolveCommentCommand(ctx, payload);

        expect(replyToThreadSpy).toHaveBeenCalledWith(payload.reply, true);
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });

    test('command handlers return early if reply is falsy', async () => {
        await replyCommentCommand(ctx, createReplyCommentPayload([]));
        await ackCommentCommand(ctx, createAckCommentPayload([]));
        await doneCommentCommand(ctx, createDoneCommentPayload([]));
        await replyAndResolveCommentCommand(ctx, createReplyAndResolveCommentPayload([]));

        expect(replyToThreadSpy).not.toHaveBeenCalled();
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });
});
