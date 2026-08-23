/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import {
    ackCommentCommand,
    type CommentThread,
    doneCommentCommand,
    replyAndResolveCommentCommand,
    replyCommentCommand,
} from '../commands/comments';
import type { CommentsManager } from '../comments-manager';
import type { JjRepository } from '../jj-repository';
import { Uri } from '../uri-utils';
import { FakeCommandContext } from './fake-host-environment';
import { createMock } from './test-utils';

describe('Comment Command Handlers', () => {
    let mockCommentsManager: CommentsManager;
    let replyToThreadSpy: Mock;
    let toggleResolveThreadSpy: Mock;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        vi.clearAllMocks();

        // Create spies
        replyToThreadSpy = vi.fn().mockResolvedValue(undefined);
        toggleResolveThreadSpy = vi.fn().mockResolvedValue(undefined);

        mockCommentsManager = createMock<CommentsManager>({
            replyToThread: replyToThreadSpy,
            toggleResolveThread: toggleResolveThreadSpy,
        });

        ctx = new FakeCommandContext(createMock<JjRepository>({}), undefined, undefined, mockCommentsManager);
    });

    test('replyCommentCommand delegates to replyToThread without resolving', async () => {
        const mockThread = createMock<CommentThread>({ uri: Uri.parse('file:///test.ts') });
        const reply = {
            thread: mockThread,
            text: 'my response',
        };

        await replyCommentCommand(ctx, { reply });

        expect(replyToThreadSpy).toHaveBeenCalledWith(reply);
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });

    test('ackCommentCommand sends Acknowledged comment and resolves the thread', async () => {
        const mockThread = createMock<CommentThread>({ uri: Uri.parse('file:///test.ts') });
        const reply = {
            thread: mockThread,
            text: 'some random typed text',
        };

        await ackCommentCommand(ctx, { reply });

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
        const mockThread = createMock<CommentThread>({ uri: Uri.parse('file:///test.ts') });
        const reply = {
            thread: mockThread,
            text: 'some random typed text',
        };

        await doneCommentCommand(ctx, { reply });

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
        const mockThread = createMock<CommentThread>({ uri: Uri.parse('file:///test.ts') });
        const reply = {
            thread: mockThread,
            text: 'my typed response',
        };

        await replyAndResolveCommentCommand(ctx, { reply });

        expect(replyToThreadSpy).toHaveBeenCalledWith(reply, true);
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });

    test('command handlers return early if reply is falsy', async () => {
        await replyCommentCommand(ctx, {});
        await ackCommentCommand(ctx, {});
        await doneCommentCommand(ctx, {});
        await replyAndResolveCommentCommand(ctx, {});

        expect(replyToThreadSpy).not.toHaveBeenCalled();
        expect(toggleResolveThreadSpy).not.toHaveBeenCalled();
    });
});
