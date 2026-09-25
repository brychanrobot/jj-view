/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../../../src/core/commands/command-utils';
import type {
    AckCommentPayload,
    DoneCommentPayload,
    ReplyAndResolveCommentPayload,
    ReplyCommentPayload,
    ResolveCommentThreadPayload,
    ShowCommentsPayload,
    UnresolveCommentThreadPayload,
} from '../../../../src/core/commands/comments';

export function createShowCommentsPayload(args: unknown[]): ShowCommentsPayload {
    const changeId = typeof args[0] === 'string' ? args[0] : extractRevision(args);
    return { changeId };
}

export function createReplyCommentPayload(args: unknown[]): ReplyCommentPayload {
    const arg = args[0] as ReplyCommentPayload | undefined;
    return { reply: arg?.reply };
}

export function createAckCommentPayload(args: unknown[]): AckCommentPayload {
    const arg = args[0] as AckCommentPayload | undefined;
    return { reply: arg?.reply };
}

export function createDoneCommentPayload(args: unknown[]): DoneCommentPayload {
    const arg = args[0] as DoneCommentPayload | undefined;
    return { reply: arg?.reply };
}

export function createReplyAndResolveCommentPayload(args: unknown[]): ReplyAndResolveCommentPayload {
    const arg = args[0] as ReplyAndResolveCommentPayload | undefined;
    return { reply: arg?.reply };
}

export function createResolveCommentThreadPayload(args: unknown[]): ResolveCommentThreadPayload {
    const arg = args[0] as ResolveCommentThreadPayload | undefined;
    return { arg: arg?.arg };
}

export function createUnresolveCommentThreadPayload(args: unknown[]): UnresolveCommentThreadPayload {
    const arg = args[0] as UnresolveCommentThreadPayload | undefined;
    return { arg: arg?.arg };
}
