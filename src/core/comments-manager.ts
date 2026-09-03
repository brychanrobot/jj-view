/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { CodeForgeCommentThread, CodeForgeProvider } from './code-forge-provider';
import type { CommentThread } from './comments-types';
import { type Disposable, type Event, EventEmitter } from './host/events';
import type { HostEnvironment } from './host/host-environment';
import { showJjError } from './host/ui-helpers';
import type { JjRepository } from './jj-repository';
import type { JjRepositoryManager } from './jj-repository-manager';
import type { CodeForgeChangeInfo, JjBookmark, JjLogEntry } from './jj-types';

export * from './comments-types';

export class CommentsManager implements Disposable {
    private _threads = new Map<string, CodeForgeCommentThread>();
    private _threadsList: CodeForgeCommentThread[] = [];
    private activeChangeId: string | undefined;
    private activeChangeInfo: CodeForgeChangeInfo | undefined;
    private activeRepoPath: string | undefined;
    private disposables: Disposable[] = [];
    private repoDisposables: Disposable[] = [];
    private explicitChangeId: string | undefined;
    private lastWorkingCopyId: string | undefined;
    private activeLoadController?: AbortController;

    private readonly _onDidChangeThreads = new EventEmitter<CodeForgeCommentThread[]>();
    public readonly onDidChangeThreads: Event<CodeForgeCommentThread[]> = this._onDidChangeThreads.event;

    constructor(
        private readonly repositoryManager: JjRepositoryManager,
        private readonly host: HostEnvironment,
    ) {
        // Clear comments when active repository changes
        this.disposables.push(
            this.repositoryManager.onDidChangeFocusedRepository(() => {
                this.clearThreads();
                this.activeChangeId = undefined;
                this.activeChangeInfo = undefined;
                this.activeRepoPath = undefined;
                this.explicitChangeId = undefined;
                this.lastWorkingCopyId = undefined;
                this.updateRepoSubscriptions();
            }),
        );

        this.updateRepoSubscriptions();
    }

    public get threads(): readonly CodeForgeCommentThread[] {
        return this._threadsList;
    }

    public getThreads(): readonly CodeForgeCommentThread[] {
        return this._threadsList;
    }

    public get activeChange(): CodeForgeChangeInfo | undefined {
        return this.activeChangeInfo;
    }

    public get currentChangeId(): string | undefined {
        return this.activeChangeId;
    }

    public get currentRepoPath(): string | undefined {
        return this.activeRepoPath;
    }

    private updateRepoSubscriptions(): void {
        for (const d of this.repoDisposables) {
            d.dispose();
        }
        this.repoDisposables = [];

        const repo = this.repositoryManager.focusedRepository;
        if (!repo) {
            return;
        }

        // Trigger automatic pull immediately
        this.pullCommentsAutomatically().catch(() => {});

        // Listen for status changes (e.g. checkouts, commits)
        this.repoDisposables.push(
            repo.onDidStatusChange(async () => {
                await this.pullCommentsAutomatically().catch(() => {});
            }),
        );

        // Listen for remote updates from CodeForgeService
        this.repoDisposables.push(
            repo.codeForge.onDidUpdate(async () => {
                await this.refreshActiveChangeComments().catch(() => {});
            }),
        );
    }

    /**
     * Resolves the forge change info for a given revision.
     * Uses a cached value if available, or fetches revision details from jujutsu.
     */
    private async resolveChangeInfo(
        repo: JjRepository,
        activeProvider: CodeForgeProvider,
        revision: string,
        logEntry?: JjLogEntry,
    ): Promise<CodeForgeChangeInfo | undefined> {
        try {
            if (!logEntry) {
                const logEntries = await repo.jj.getLog({ revision, omitChanges: true });
                logEntry = logEntries[0];
            }
            if (!logEntry) {
                return undefined;
            }
            const bookmarks = (logEntry.bookmarks ?? [])
                .filter((b: JjBookmark) => !b.remote)
                .map((b: JjBookmark) => b.name);
            return activeProvider.getCachedChangeInfo(logEntry.change_id, logEntry.description, bookmarks);
        } catch {
            // Ignore error
        }
        return undefined;
    }

    private startNewLoad(): AbortSignal {
        if (this.activeLoadController) {
            this.activeLoadController.abort();
        }
        this.activeLoadController = new AbortController();
        return this.activeLoadController.signal;
    }

    /**
     * Automatically detects the target revision to show comments for.
     * Checks the working copy `@` first, and falls back to the parent `@-`.
     */
    private async detectTargetChange(
        repo: JjRepository,
        activeProvider: CodeForgeProvider,
        signal: AbortSignal,
        workingCopyLogEntry?: JjLogEntry,
    ): Promise<{ changeInfo: CodeForgeChangeInfo } | undefined> {
        if (this.explicitChangeId) {
            const changeInfo = await this.resolveChangeInfo(repo, activeProvider, this.explicitChangeId);
            if (signal.aborted) {
                return undefined;
            }
            if (changeInfo) {
                return { changeInfo };
            }
            return undefined;
        }

        const workingCopyInfo = await this.resolveChangeInfo(repo, activeProvider, '@', workingCopyLogEntry);
        if (signal.aborted) {
            return undefined;
        }
        if (workingCopyInfo) {
            return { changeInfo: workingCopyInfo };
        }

        let parentLogEntry: JjLogEntry | undefined;
        try {
            const parentLogEntries = await repo.jj.getLog({ revision: '@-', omitChanges: true });
            if (signal.aborted) {
                return undefined;
            }
            parentLogEntry = parentLogEntries[0];
        } catch {
            // Ignore
        }

        const parentInfo = await this.resolveChangeInfo(repo, activeProvider, '@-', parentLogEntry);
        if (signal.aborted) {
            return undefined;
        }
        if (parentInfo) {
            return { changeInfo: parentInfo };
        }

        return undefined;
    }

    /**
     * Periodically or reactively pulls comments for the active target change.
     * Cancels any active load if a new pull is triggered.
     */
    public async pullCommentsAutomatically(): Promise<void> {
        const signal = this.startNewLoad();

        try {
            const repo = this.repositoryManager.focusedRepository;
            if (!repo) {
                this.clearThreads();
                this.activeChangeId = undefined;
                this.activeChangeInfo = undefined;
                this.activeRepoPath = undefined;
                return;
            }
            if (signal.aborted) {
                return;
            }

            const { activeProvider } = repo.codeForge;
            if (!activeProvider?.getCommentThreads) {
                this.clearThreads();
                this.activeChangeId = undefined;
                this.activeChangeInfo = undefined;
                this.activeRepoPath = undefined;
                return;
            }

            // Check if the working copy @ has changed commit ID
            let currentWorkingCopyId: string | undefined;
            let workingCopyLogEntry: JjLogEntry | undefined;
            try {
                const logEntries = await repo.jj.getLog({ revision: '@', omitChanges: true });
                if (signal.aborted) {
                    return;
                }
                workingCopyLogEntry = logEntries[0];
                currentWorkingCopyId = workingCopyLogEntry?.commit_id;
            } catch {
                // Ignore
            }

            if (
                this.lastWorkingCopyId !== undefined &&
                currentWorkingCopyId &&
                currentWorkingCopyId !== this.lastWorkingCopyId
            ) {
                // Working copy changed (e.g. checkout / commit), reset explicit change targeting
                this.explicitChangeId = undefined;
            }
            if (currentWorkingCopyId) {
                this.lastWorkingCopyId = currentWorkingCopyId;
            }

            const target = await this.detectTargetChange(repo, activeProvider, signal, workingCopyLogEntry);
            if (signal.aborted) {
                return;
            }

            if (target) {
                await this.loadCommentsForChange(target.changeInfo, signal);
            } else {
                this.clearThreads();
                this.activeChangeId = undefined;
                this.activeChangeInfo = undefined;
                this.activeRepoPath = undefined;
            }
        } catch {
            // Ignore
        }
    }

    /**
     * Lightweight method to pull comments for the active target change directly.
     * Avoids running any slow jj CLI queries.
     */
    public async refreshActiveChangeComments(): Promise<void> {
        const repo = this.repositoryManager.focusedRepository;
        if (!repo || !this.activeChangeInfo) {
            return;
        }
        const signal = this.startNewLoad();
        await this.loadCommentsForChange(this.activeChangeInfo, signal);
    }

    /**
     * Loads comment threads from the forge provider for a specific revision.
     */
    private async loadCommentsForChange(changeInfo: CodeForgeChangeInfo, signal: AbortSignal): Promise<void> {
        const repo = this.repositoryManager.focusedRepository;
        if (!repo) {
            return;
        }

        const { activeProvider } = repo.codeForge;
        if (!activeProvider?.getCommentThreads) {
            return;
        }

        const providerChangeId = changeInfo.id;
        if (signal.aborted) {
            return;
        }

        // Clear existing threads immediately if switching to a different change to avoid stale state
        if (this.activeChangeId !== providerChangeId) {
            this.clearThreads();
            this.activeChangeId = undefined;
            this.activeChangeInfo = undefined;
            this.activeRepoPath = undefined;
        }

        const provider = activeProvider as Required<Pick<CodeForgeProvider, 'getCommentThreads'>> & CodeForgeProvider;

        try {
            const threadsList = await provider.getCommentThreads(providerChangeId, signal);
            if (signal.aborted) {
                return;
            }
            this.activeChangeId = providerChangeId;
            this.activeChangeInfo = changeInfo;
            this.activeRepoPath = repo.rootUri.fsPath;
            this._threadsList = threadsList;
            this._threads = new Map(threadsList.map((t) => [t.id, t]));
            this._onDidChangeThreads.fire(threadsList);
        } catch {
            // Ignore/log
        }
    }

    public async showCommentsForChange(changeId: string): Promise<void> {
        this.explicitChangeId = changeId;
        const signal = this.startNewLoad();

        const repo = this.repositoryManager.focusedRepository;
        if (!repo) {
            return;
        }
        const { activeProvider } = repo.codeForge;
        if (!activeProvider) {
            return;
        }

        const changeInfo = await this.resolveChangeInfo(repo, activeProvider, changeId);
        if (signal.aborted) {
            return;
        }

        if (changeInfo) {
            await this.loadCommentsForChange(changeInfo, signal);
        } else {
            this.clearThreads();
            this.activeChangeId = undefined;
            this.activeChangeInfo = undefined;
            this.activeRepoPath = undefined;
        }
    }

    private clearThreads(): void {
        this._threadsList = [];
        this._threads.clear();
        this._onDidChangeThreads.fire([]);
    }

    public async replyToThread(reply: { thread: CommentThread; text?: string }, resolved?: boolean): Promise<void> {
        const repo = this.repositoryManager.focusedRepository;
        const changeId = this.activeChangeId;
        if (!repo || !changeId) {
            return;
        }

        const { activeProvider } = repo.codeForge;
        if (!activeProvider?.replyToCommentThread || !activeProvider.getCommentThreads) {
            return;
        }

        const threadId = reply.thread.id;
        if (!threadId) {
            return;
        }

        const targetThread = this._threads.get(threadId);
        if (!targetThread) {
            await showJjError(
                this.host.ui,
                new Error(`Comment thread not found: ${threadId}`),
                'Failed to send reply',
                repo?.jj,
                this.repositoryManager.outputChannel,
            );
            return;
        }

        const provider = activeProvider as Required<
            Pick<CodeForgeProvider, 'replyToCommentThread' | 'getCommentThreads'>
        > &
            CodeForgeProvider;

        const replyText = reply.text ?? '';
        const executeReply = async () => {
            await provider.replyToCommentThread(changeId, targetThread, replyText, resolved);
            await this.refreshActiveChangeComments();
            repo.codeForge.requestRefreshWithBackoffs();
        };

        try {
            await this.host.ui.withProgress('Sending reply...', executeReply);
        } catch (err: unknown) {
            await showJjError(
                this.host.ui,
                err,
                'Failed to send reply',
                repo?.jj,
                this.repositoryManager.outputChannel,
            );
        }
    }

    public async toggleResolveThread(thread: CommentThread, resolved: boolean): Promise<void> {
        const repo = this.repositoryManager.focusedRepository;
        const changeId = this.activeChangeId;
        if (!repo || !changeId) {
            return;
        }

        const { activeProvider } = repo.codeForge;
        if (!activeProvider?.resolveCommentThread || !activeProvider.getCommentThreads) {
            return;
        }

        const threadId = thread.id;
        if (!threadId) {
            return;
        }

        const targetThread = this._threads.get(threadId);
        if (!targetThread) {
            await showJjError(
                this.host.ui,
                new Error(`Comment thread not found: ${threadId}`),
                'Failed to toggle resolve',
                repo?.jj,
                this.repositoryManager.outputChannel,
            );
            return;
        }

        const provider = activeProvider as Required<
            Pick<CodeForgeProvider, 'resolveCommentThread' | 'getCommentThreads'>
        > &
            CodeForgeProvider;

        const executeToggle = async () => {
            await provider.resolveCommentThread(changeId, targetThread, resolved);
            await this.refreshActiveChangeComments();
            repo.codeForge.requestRefreshWithBackoffs();
        };

        try {
            await this.host.ui.withProgress(resolved ? 'Resolving thread...' : 'Unresolving thread...', executeToggle);
        } catch (err: unknown) {
            await showJjError(
                this.host.ui,
                err,
                'Failed to toggle resolve',
                repo?.jj,
                this.repositoryManager.outputChannel,
            );
        }
    }

    public formatUnresolvedComments(workspaceRoot?: string): string | undefined {
        const unresolvedThreads = this._threadsList.filter((thread) => !thread.isResolved);
        if (unresolvedThreads.length === 0) {
            return undefined;
        }

        const root = workspaceRoot ?? this.activeRepoPath;
        const sorted = [...unresolvedThreads].sort((a, b) => {
            const pathA = a.filePath ?? '';
            const pathB = b.filePath ?? '';
            if (pathA !== pathB) {
                return pathA.localeCompare(pathB);
            }
            const lineA = a.line ?? 0;
            const lineB = b.line ?? 0;
            return lineA - lineB;
        });

        const info = this.activeChangeInfo;
        const changeLabel = info ? ` for ${info.displayLabel}` : '';
        let result = `### Unresolved Comments${changeLabel}\n\n`;

        for (const thread of sorted) {
            let relativePath = '';
            if (thread.filePath) {
                const fullPath = path.isAbsolute(thread.filePath)
                    ? thread.filePath
                    : root
                      ? path.join(root, thread.filePath)
                      : thread.filePath;
                relativePath = root ? path.relative(root, fullPath) : thread.filePath;
            }
            const displayPath = relativePath || thread.filePath || 'unknown';

            if (thread.line !== undefined && thread.line > 0) {
                result += `- **${displayPath}:${thread.line}**\n`;
            } else {
                result += `- **${displayPath}**\n`;
            }

            for (const comment of thread.comments) {
                const author = comment.author?.name || 'Unknown';
                const body = comment.body ?? '';
                const indentedBody = body
                    .split(/\r?\n/)
                    .map((line) => `    > ${line}`)
                    .join('\n');
                result += `  - **${author}**:\n${indentedBody}\n`;
            }
        }

        return `${result.trim()}\n`;
    }

    public async copyUnresolvedComments(): Promise<void> {
        const repo = this.repositoryManager.focusedRepository;
        const text = this.formatUnresolvedComments(repo?.rootUri.fsPath);
        if (!text) {
            await this.host.ui.showInformation('No unresolved comments for the active change.');
            return;
        }

        const unresolvedCount = this._threadsList.filter((t) => !t.isResolved).length;

        try {
            await this.host.nav.copyToClipboard(text);
            await this.host.ui.showInformation(`Copied ${unresolvedCount} unresolved comment(s) to clipboard.`);
        } catch (error: unknown) {
            await showJjError(
                this.host.ui,
                error,
                'Failed to copy comments to clipboard',
                repo?.jj,
                this.repositoryManager.outputChannel,
            );
        }
    }

    public dispose(): void {
        if (this.activeLoadController) {
            this.activeLoadController.abort();
        }
        this.clearThreads();
        for (const d of this.repoDisposables) {
            d.dispose();
        }
        this.repoDisposables = [];
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
        this._onDidChangeThreads.dispose();
    }
}
