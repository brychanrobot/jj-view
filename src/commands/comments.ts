/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as vscode from 'vscode';
import { ACK_REPLY_TEXT, DONE_REPLY_TEXT } from '../comments-constants';
import type { CommentsManager } from '../comments-manager';

export async function showCommentsCommand(commentsManager: CommentsManager, changeId?: string) {
    if (!changeId) {
        return;
    }
    await commentsManager.showCommentsForChange(changeId);
}

export async function replyCommentCommand(commentsManager: CommentsManager, reply?: vscode.CommentReply) {
    if (!reply) {
        return;
    }
    await commentsManager.replyToThread(reply);
}

export async function ackCommentCommand(commentsManager: CommentsManager, reply?: vscode.CommentReply) {
    if (!reply) {
        return;
    }
    await commentsManager.replyToThread(
        {
            thread: reply.thread,
            text: ACK_REPLY_TEXT,
        },
        /* resolved */ true,
    );
}

export async function doneCommentCommand(commentsManager: CommentsManager, reply?: vscode.CommentReply) {
    if (!reply) {
        return;
    }
    await commentsManager.replyToThread(
        {
            thread: reply.thread,
            text: DONE_REPLY_TEXT,
        },
        /* resolved */ true,
    );
}

export async function replyAndResolveCommentCommand(commentsManager: CommentsManager, reply?: vscode.CommentReply) {
    if (!reply) {
        return;
    }
    await commentsManager.replyToThread(reply, /* resolved */ true);
}

export async function resolveCommentThreadCommand(
    commentsManager: CommentsManager,
    arg?: vscode.CommentThread | vscode.CommentReply,
) {
    if (!arg) {
        return;
    }
    const thread = 'thread' in arg ? arg.thread : arg;
    await commentsManager.toggleResolveThread(thread, /* resolved */ true);
}

export async function unresolveCommentThreadCommand(
    commentsManager: CommentsManager,
    arg?: vscode.CommentThread | vscode.CommentReply,
) {
    if (!arg) {
        return;
    }
    const thread = 'thread' in arg ? arg.thread : arg;
    await commentsManager.toggleResolveThread(thread, /* resolved */ false);
}

export async function copyUnresolvedCommentsCommand(commentsManager: CommentsManager) {
    await commentsManager.copyUnresolvedComments();
}
