/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as vscode from 'vscode';
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

export async function resolveCommentThreadCommand(
    commentsManager: CommentsManager,
    arg?: vscode.CommentThread | vscode.CommentReply,
) {
    if (!arg) {
        return;
    }
    const thread = 'thread' in arg ? arg.thread : arg;
    await commentsManager.toggleResolveThread(thread, true);
}

export async function unresolveCommentThreadCommand(
    commentsManager: CommentsManager,
    arg?: vscode.CommentThread | vscode.CommentReply,
) {
    if (!arg) {
        return;
    }
    const thread = 'thread' in arg ? arg.thread : arg;
    await commentsManager.toggleResolveThread(thread, false);
}

export async function copyUnresolvedCommentsCommand(commentsManager: CommentsManager) {
    await commentsManager.copyUnresolvedComments();
}
