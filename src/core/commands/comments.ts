/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ACK_REPLY_TEXT, DONE_REPLY_TEXT } from '../comments-constants';
import {
    type Comment,
    type CommentAuthorInformation,
    type CommentBody,
    CommentMode,
    type CommentReaction,
    type CommentThread,
    CommentThreadCollapsibleState,
    CommentThreadState,
} from '../comments-types';
import type { CommandContext } from '../common/command-context';

export type { Comment, CommentAuthorInformation, CommentBody, CommentReaction, CommentThread };
export { CommentMode, CommentThreadCollapsibleState, CommentThreadState };

export interface CommentReplyPayload {
    thread: CommentThread;
    text?: string;
}

export interface ShowCommentsPayload {
    changeId?: string;
}

export interface ReplyCommentPayload {
    reply?: CommentReplyPayload;
}

export interface AckCommentPayload {
    reply?: CommentReplyPayload;
}

export interface DoneCommentPayload {
    reply?: CommentReplyPayload;
}

export interface ReplyAndResolveCommentPayload {
    reply?: CommentReplyPayload;
}

export interface ResolveCommentThreadPayload {
    arg?: CommentThread | CommentReplyPayload;
}

export interface UnresolveCommentThreadPayload {
    arg?: CommentThread | CommentReplyPayload;
}

export async function showCommentsCommand(ctx: CommandContext, payload?: ShowCommentsPayload): Promise<void> {
    const commentsManager = ctx.services?.commentsManager;
    const changeId = payload?.changeId;
    if (!commentsManager || !changeId) {
        return;
    }
    await commentsManager.showCommentsForChange(changeId);
    await ctx.host.commands.executeCommand('workbench.action.focusCommentsPanel').catch(() => {});
}

export async function replyCommentCommand(ctx: CommandContext, payload?: ReplyCommentPayload): Promise<void> {
    const reply = payload?.reply;
    if (!reply) {
        return;
    }
    await ctx.services?.commentsManager?.replyToThread(reply);
}

export async function ackCommentCommand(ctx: CommandContext, payload?: AckCommentPayload): Promise<void> {
    const reply = payload?.reply;
    if (!reply) {
        return;
    }
    await ctx.services?.commentsManager?.replyToThread(
        {
            thread: reply.thread,
            text: ACK_REPLY_TEXT,
        },
        /* resolved */ true,
    );
}

export async function doneCommentCommand(ctx: CommandContext, payload?: DoneCommentPayload): Promise<void> {
    const reply = payload?.reply;
    if (!reply) {
        return;
    }
    await ctx.services?.commentsManager?.replyToThread(
        {
            thread: reply.thread,
            text: DONE_REPLY_TEXT,
        },
        /* resolved */ true,
    );
}

export async function replyAndResolveCommentCommand(
    ctx: CommandContext,
    payload?: ReplyAndResolveCommentPayload,
): Promise<void> {
    const reply = payload?.reply;
    if (!reply) {
        return;
    }
    await ctx.services?.commentsManager?.replyToThread(reply, /* resolved */ true);
}

export async function resolveCommentThreadCommand(
    ctx: CommandContext,
    payload?: ResolveCommentThreadPayload,
): Promise<void> {
    const arg = payload?.arg;
    if (!arg) {
        return;
    }
    const thread = 'thread' in arg ? arg.thread : arg;
    await ctx.services?.commentsManager?.toggleResolveThread(thread, /* resolved */ true);
}

export async function unresolveCommentThreadCommand(
    ctx: CommandContext,
    payload?: UnresolveCommentThreadPayload,
): Promise<void> {
    const arg = payload?.arg;
    if (!arg) {
        return;
    }
    const thread = 'thread' in arg ? arg.thread : arg;
    await ctx.services?.commentsManager?.toggleResolveThread(thread, /* resolved */ false);
}

export async function copyUnresolvedCommentsCommand(ctx: CommandContext): Promise<void> {
    await ctx.services?.commentsManager?.copyUnresolvedComments();
}
