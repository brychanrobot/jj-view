/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommentsManager } from '../comments-manager';
import type { CommandContext, CommandServices } from '../common/command-context';
import type { HostEnvironment } from '../common/host-environment';
import type { JjRepository } from '../jj-repository';
import type { LoggerChannel } from '../utils/output-channel';

export class VSCodeCommandContext implements CommandContext {
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
