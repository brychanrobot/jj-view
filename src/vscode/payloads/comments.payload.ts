/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { extractRevision } from '../../commands/command-utils';
import {
    type AckCommentPayload,
    type Comment,
    CommentMode,
    type CommentReplyPayload,
    type CommentThread,
    CommentThreadCollapsibleState,
    CommentThreadState,
    type DoneCommentPayload,
    type ReplyAndResolveCommentPayload,
    type ReplyCommentPayload,
    type ResolveCommentThreadPayload,
    type ShowCommentsPayload,
    type UnresolveCommentThreadPayload,
} from '../../commands/comments';
import { Uri } from '../../uri-utils';

function fromVscodeCommentMode(mode?: vscode.CommentMode): CommentMode | undefined {
    if (mode === undefined) {
        return undefined;
    }
    switch (mode) {
        case vscode.CommentMode.Preview:
            return CommentMode.Preview;
        case vscode.CommentMode.Editing:
            return CommentMode.Editing;
    }
}

function fromVscodeCommentThreadState(state?: vscode.CommentThreadState): CommentThreadState | undefined {
    if (state === undefined) {
        return undefined;
    }
    switch (state) {
        case vscode.CommentThreadState.Unresolved:
            return CommentThreadState.Unresolved;
        case vscode.CommentThreadState.Resolved:
            return CommentThreadState.Resolved;
    }
}

function fromVscodeCommentThreadCollapsibleState(
    state?: vscode.CommentThreadCollapsibleState,
): CommentThreadCollapsibleState | undefined {
    if (state === undefined) {
        return undefined;
    }
    switch (state) {
        case vscode.CommentThreadCollapsibleState.Collapsed:
            return CommentThreadCollapsibleState.Collapsed;
        case vscode.CommentThreadCollapsibleState.Expanded:
            return CommentThreadCollapsibleState.Expanded;
    }
}

function fromVscodeComment(comment: vscode.Comment): Comment {
    let bodyValue: string | undefined;
    if (typeof comment.body === 'string') {
        bodyValue = comment.body;
    } else if (typeof comment.body === 'object' && comment.body !== null && 'value' in comment.body) {
        bodyValue = comment.body.value;
    }

    return {
        body: bodyValue !== undefined ? { value: bodyValue } : undefined,
        mode: fromVscodeCommentMode(comment.mode),
        author: comment.author ? { name: comment.author.name, iconPath: comment.author.iconPath } : undefined,
        contextValue: comment.contextValue,
        reactions: comment.reactions?.map((r) => ({
            label: r.label,
            iconPath: typeof r.iconPath === 'string' ? Uri.parse(r.iconPath) : r.iconPath,
            count: r.count,
            authorHasReacted: r.authorHasReacted,
        })),
        label: comment.label,
        timestamp: comment.timestamp,
    };
}

function extractThreadId(thread: vscode.CommentThread): string | undefined {
    if ('id' in thread && typeof thread.id === 'string' && thread.id.length > 0) {
        return thread.id;
    }
    if (!thread.contextValue) {
        return undefined;
    }
    const match = /^(?:resolved|unresolved):(.+)$/.exec(thread.contextValue);
    return match ? match[1] : undefined;
}

function fromVscodeCommentThread(thread: vscode.CommentThread): CommentThread | undefined {
    const threadId = extractThreadId(thread);
    if (!threadId) {
        return undefined;
    }
    return {
        id: threadId,
        uri: thread.uri,
        range: thread.range && {
            start: { line: thread.range.start.line, character: thread.range.start.character },
            end: { line: thread.range.end.line, character: thread.range.end.character },
        },
        comments: thread.comments?.map(fromVscodeComment),
        collapsibleState: fromVscodeCommentThreadCollapsibleState(thread.collapsibleState),
        state: fromVscodeCommentThreadState(thread.state),
        canReply: Boolean(thread.canReply),
    };
}

function fromVscodeCommentReply(reply: vscode.CommentReply | undefined): CommentReplyPayload | undefined {
    if (!reply) {
        return undefined;
    }
    const thread = fromVscodeCommentThread(reply.thread);
    if (!thread) {
        return undefined;
    }
    return {
        thread,
        text: reply.text,
    };
}

function isVscodeCommentReply(arg: unknown): arg is vscode.CommentReply {
    return (
        typeof arg === 'object' &&
        arg !== null &&
        'thread' in arg &&
        typeof (arg as { thread: unknown }).thread === 'object' &&
        (arg as { thread: unknown }).thread !== null
    );
}

function isVscodeCommentThread(arg: unknown): arg is vscode.CommentThread {
    return typeof arg === 'object' && arg !== null && 'uri' in arg && Uri.isUri((arg as { uri: unknown }).uri);
}

export function createShowCommentsPayload(args: unknown[]): ShowCommentsPayload {
    const changeId = typeof args[0] === 'string' ? args[0] : extractRevision(args);
    return { changeId };
}

export function createReplyCommentPayload(args: unknown[]): ReplyCommentPayload {
    const arg = args[0];
    const reply = isVscodeCommentReply(arg) ? fromVscodeCommentReply(arg) : undefined;
    return { reply };
}

export function createAckCommentPayload(args: unknown[]): AckCommentPayload {
    const arg = args[0];
    const reply = isVscodeCommentReply(arg) ? fromVscodeCommentReply(arg) : undefined;
    return { reply };
}

export function createDoneCommentPayload(args: unknown[]): DoneCommentPayload {
    const arg = args[0];
    const reply = isVscodeCommentReply(arg) ? fromVscodeCommentReply(arg) : undefined;
    return { reply };
}

export function createReplyAndResolveCommentPayload(args: unknown[]): ReplyAndResolveCommentPayload {
    const arg = args[0];
    const reply = isVscodeCommentReply(arg) ? fromVscodeCommentReply(arg) : undefined;
    return { reply };
}

function parseThreadOrReplyArg(args: unknown[]): CommentThread | CommentReplyPayload | undefined {
    const arg = args[0];
    if (isVscodeCommentReply(arg)) {
        return fromVscodeCommentReply(arg);
    }
    if (isVscodeCommentThread(arg)) {
        return fromVscodeCommentThread(arg);
    }
    return undefined;
}

export function createResolveCommentThreadPayload(args: unknown[]): ResolveCommentThreadPayload {
    return {
        arg: parseThreadOrReplyArg(args),
    };
}

export function createUnresolveCommentThreadPayload(args: unknown[]): UnresolveCommentThreadPayload {
    return {
        arg: parseThreadOrReplyArg(args),
    };
}
