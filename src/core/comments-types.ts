/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Uri } from './uri-utils';

export interface CommentPosition {
    line: number;
    character: number;
}

export interface CommentRange {
    start: CommentPosition;
    end: CommentPosition;
}

export enum CommentThreadState {
    Unresolved = 0,
    Resolved = 1,
}

export enum CommentThreadCollapsibleState {
    Collapsed = 0,
    Expanded = 1,
}

export enum CommentMode {
    Preview = 0,
    Editing = 1,
}

export interface CommentAuthorInformation {
    name?: string;
    iconPath?: Uri;
}

export interface CommentReaction {
    label?: string;
    iconPath?: Uri;
    count?: number;
    authorHasReacted?: boolean;
}

export interface CommentBody {
    value?: string;
}

export interface Comment {
    body?: CommentBody;
    mode?: CommentMode;
    author?: CommentAuthorInformation;
    contextValue?: string;
    reactions?: readonly CommentReaction[];
    label?: string;
    timestamp?: Date;
}

export interface CommentThread {
    id: string;
    uri: Uri;
    range?: CommentRange;
    comments?: readonly Comment[];
    collapsibleState?: CommentThreadCollapsibleState;
    state?: CommentThreadState;
    canReply?: boolean;
}
