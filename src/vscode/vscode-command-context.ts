/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommentsManager } from '../comments-manager';
import type {
    CommandConfig,
    CommandContext,
    CommandNavigation,
    CommandServices,
    CommandUI,
    HostDocuments,
} from '../common/command-context';
import type { JjRepository } from '../jj-repository';
import type { JjLoggerChannel } from '../utils/output-channel';
import {
    closeTabsForUri,
    VsCodeHostConfig,
    VsCodeHostDocuments,
    VsCodeHostEnvironment,
    VsCodeHostNavigation,
    VsCodeHostUi,
} from './vscode-host-environment';

export {
    closeTabsForUri,
    VsCodeHostConfig as VSCodeCommandConfig,
    VsCodeHostDocuments,
    VsCodeHostNavigation as VSCodeCommandNavigation,
    VsCodeHostUi as VSCodeCommandUI,
};

export class VSCodeCommandContext implements CommandContext {
    readonly ui: CommandUI;
    readonly config: CommandConfig;
    readonly nav: CommandNavigation;
    readonly documents: HostDocuments;
    readonly services: CommandServices;
    readonly host: VsCodeHostEnvironment;

    constructor(
        readonly repo: JjRepository,
        readonly log: JjLoggerChannel,
        commentsManager?: CommentsManager,
        sourceControl?: { inputBox: { value: string } },
    ) {
        this.host = new VsCodeHostEnvironment({ repo, log, sourceControl });
        this.ui = this.host.ui;
        this.config = this.host.config;
        this.nav = this.host.nav;
        this.documents = this.host.documents;
        this.services = { commentsManager };
    }
}
