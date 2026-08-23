/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommentsManager } from '../comments-manager';
import type { JjRepository } from '../jj-repository';
import type { JjLoggerChannel } from '../utils/output-channel';
import type { HostEnvironment } from './host-environment';

export interface CommandServices {
    readonly commentsManager?: CommentsManager;
}

export interface CommandContext {
    readonly repo: JjRepository;
    readonly host: HostEnvironment;
    readonly log: JjLoggerChannel;
    readonly services?: CommandServices;
}
