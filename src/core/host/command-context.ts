/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommentsManager } from '../comments-manager';
import type { JjRepository } from '../jj-repository';
import type { LoggerChannel } from '../utils/output-channel';
import type { HostEnvironment } from './host-environment';

export interface CommandServices {
    readonly commentsManager?: CommentsManager;
}

export interface CommandContext {
    readonly repo: JjRepository;
    readonly host: HostEnvironment;
    readonly log: LoggerChannel;
    readonly services?: CommandServices;
}

export class BaseCommandContext implements CommandContext {
    readonly services?: CommandServices;

    constructor(
        readonly repo: JjRepository,
        readonly host: HostEnvironment,
        readonly log: LoggerChannel,
        comments?: CommentsManager,
    ) {
        this.services = comments ? { commentsManager: comments } : undefined;
    }
}
