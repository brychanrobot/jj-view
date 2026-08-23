/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommentsManager } from '../comments-manager';
import type { CommandContext, CommandServices } from '../common/command-context';
import type { HostEnvironment } from '../common/host-environment';
import type { JjRepository } from '../jj-repository';
import type { JjLoggerChannel } from '../utils/output-channel';
import { VsCodeHostEnvironment } from './vscode-host-environment';

export class VSCodeCommandContext implements CommandContext {
    readonly repo: JjRepository;
    readonly host: HostEnvironment;
    readonly log: JjLoggerChannel;
    readonly services?: CommandServices;

    constructor(repo: JjRepository, host: HostEnvironment, log: JjLoggerChannel, comments?: CommentsManager);
    constructor(
        repo: JjRepository,
        log: JjLoggerChannel,
        comments?: CommentsManager,
        sourceControl?: { inputBox: { value: string } },
    );
    constructor(
        repo: JjRepository,
        hostOrLog: HostEnvironment | JjLoggerChannel,
        logOrComments?: JjLoggerChannel | CommentsManager,
        commentsOrSourceControl?: CommentsManager | { inputBox: { value: string } },
        sourceControl?: { inputBox: { value: string } },
    ) {
        this.repo = repo;
        if ('ui' in hostOrLog) {
            this.host = hostOrLog;
            this.log = logOrComments as JjLoggerChannel;
            this.services = { commentsManager: commentsOrSourceControl as CommentsManager | undefined };
        } else {
            this.log = hostOrLog;
            this.services = { commentsManager: logOrComments as CommentsManager | undefined };
            const sc = (sourceControl ??
                (commentsOrSourceControl && 'inputBox' in commentsOrSourceControl
                    ? commentsOrSourceControl
                    : undefined)) as { inputBox: { value: string } } | undefined;
            this.host = new VsCodeHostEnvironment({ repo: this.repo, log: this.log, sourceControl: sc });
        }
    }
}
