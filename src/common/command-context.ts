/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommentsManager } from '../comments-manager';
import type { JjRepository } from '../jj-repository';
import type { JjLoggerChannel } from '../utils/output-channel';
import type { HostConfig, HostDocuments, HostNavigation, HostUi } from './host-environment';

export type CommandUI = HostUi;
export type CommandConfig = HostConfig;
export type CommandNavigation = HostNavigation;
export type { HostDocuments } from './host-environment';

export interface CommandServices {
    commentsManager?: CommentsManager;
}

export interface CommandContext {
    readonly repo: JjRepository;
    readonly ui: CommandUI;
    readonly config: CommandConfig;
    readonly nav: CommandNavigation;
    readonly documents: HostDocuments;
    readonly log: JjLoggerChannel;
    readonly services: CommandServices;
}

export type {
    HostAuth,
    HostAuthSession,
    HostCommands,
    HostDisposable,
    HostEnvironment,
    HostSecrets,
    HostStorage,
    HostUi,
} from './host-environment';
