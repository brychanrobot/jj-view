/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CodeForgeComment, CodeForgeCommentThread, CodeForgeProvider } from './code-forge-provider';
import type { JjRepository } from './jj-repository';
import type { JjRepositoryManager } from './jj-repository-manager';
import type { CodeForgeChangeInfo, JjBookmark, JjLogEntry } from './jj-types';
import { Uri } from './uri-utils';

export class CommentsManager implements vscode.Disposable {
    private commentController: vscode.CommentController;
    private threads = new Map<string, vscode.CommentThread>(); // threadId -> vscode.CommentThread
    private activeChangeId: string | undefined;
    private activeChangeInfo: CodeForgeChangeInfo | undefined;
    private activeRepoPath: string | undefined;
    private disposables: vscode.Disposable[] = [];
    private repoDisposables: vscode.Disposable[] = [];
    private explicitChangeId: string | undefined;
    private lastWorkingCopyId: string | undefined;
    private activeLoadController?: AbortController;

    public getThreads(): Map<string, vscode.CommentThread> {
        return this.threads;
    }

    constructor(private readonly repositoryManager: JjRepositoryManager) {
        this.commentController = vscode.comments.createCommentController('jj-view.comments', 'JJ Comments');
        this.disposables.push(this.commentController);

        // Set commenting range provider to return undefined, so users reply to existing comments only
        this.commentController.commentingRangeProvider = {
            provideCommentingRanges: () => undefined,
        };

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

    private updateRepoSubscriptions() {
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
            const bookmarks =
                logEntry.bookmarks?.filter((b: JjBookmark) => !b.remote).map((b: JjBookmark) => b.name) || [];
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
     * Loads and renders comment threads from the forge provider for a specific revision.
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

        // Clear existing threads immediately if switching to a different change to avoid stale UI state
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
            this.updateCommentThreads(threadsList);
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
        // Focus the native comments panel
        await vscode.commands.executeCommand('workbench.action.focusCommentsPanel');
    }

    private clearThreads() {
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
    }

    /**
     * Maps a CodeForge provider comment to a VS Code comment structure.
     */
    private mapToVscodeComment(c: CodeForgeComment): vscode.Comment {
        let avatarUri: Uri | undefined;
        if (c.author?.avatarUrl) {
            try {
                avatarUri = Uri.parse(c.author.avatarUrl);
            } catch {
                // Ignore malformed avatar URIs
            }
        }
        return {
            body: new vscode.MarkdownString(c.body),
            author: {
                name: c.author?.name || 'Unknown',
                iconPath: avatarUri,
            },
            label: c.isDraft ? 'Draft' : undefined,
            mode: vscode.CommentMode.Preview,
        };
    }

    /**
     * Syncs a CodeForge comment thread with a VS Code CommentThread instance,
     * updating comments, position, and resolution state.
     */
    private syncCommentThread(thread: CodeForgeCommentThread, activeRepoPath: string): vscode.CommentThread {
        const fileUri = Uri.file(path.join(activeRepoPath, thread.filePath ?? ''));
        const line = Math.max(0, (thread.line ?? 1) - 1);
        const range = new vscode.Range(line, 0, line, 0);

        const comments = thread.comments.map((c) => this.mapToVscodeComment(c));

        const expectedCollapsibleState = thread.isResolved
            ? vscode.CommentThreadCollapsibleState.Collapsed
            : vscode.CommentThreadCollapsibleState.Expanded;

        let vscodeThread = this.threads.get(thread.id);
        if (!vscodeThread) {
            vscodeThread = this.commentController.createCommentThread(fileUri, range, comments);
            vscodeThread.canReply = true;
            vscodeThread.collapsibleState = expectedCollapsibleState;
            this.threads.set(thread.id, vscodeThread);
        } else {
            vscodeThread.comments = comments;
            vscodeThread.range = range; // Update range!
            // Only update collapsibleState if the resolution state has transitioned
            const previousResolved = vscodeThread.contextValue === 'resolved';
            if (previousResolved !== thread.isResolved) {
                vscodeThread.collapsibleState = expectedCollapsibleState;
            }
        }

        // Set context value to allow resolve/unresolve actions
        vscodeThread.contextValue = thread.isResolved ? 'resolved' : 'unresolved';
        vscodeThread.state = thread.isResolved
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;

        return vscodeThread;
    }

    /**
     * Batch updates VS Code SCM comment threads based on a list from the forge provider,
     * removing threads that are no longer present.
     */
    private updateCommentThreads(threadsList: CodeForgeCommentThread[]) {
        if (!this.activeRepoPath) {
            this.clearThreads();
            return;
        }

        const activeThreadIds = new Set<string>();

        for (const thread of threadsList) {
            if (!thread.filePath || thread.line === undefined) {
                continue;
            }

            activeThreadIds.add(thread.id);
            this.syncCommentThread(thread, this.activeRepoPath);
        }

        // Dispose threads that are no longer active
        for (const [id, thread] of this.threads.entries()) {
            if (!activeThreadIds.has(id)) {
                thread.dispose();
                this.threads.delete(id);
            }
        }
    }

    public async replyToThread(reply: vscode.CommentReply, resolved?: boolean): Promise<void> {
        const repo = this.repositoryManager.focusedRepository;
        const changeId = this.activeChangeId;
        if (!repo || !changeId) {
            return;
        }

        const { activeProvider } = repo.codeForge;
        if (!activeProvider?.replyToCommentThread || !activeProvider.getCommentThreads) {
            return;
        }

        // Find thread ID matching the vscode comment thread
        let foundThreadId: string | undefined;
        for (const [id, t] of this.threads.entries()) {
            if (t === reply.thread) {
                foundThreadId = id;
                break;
            }
        }

        if (!foundThreadId) {
            return;
        }

        const threadId = foundThreadId;
        const provider = activeProvider as Required<
            Pick<CodeForgeProvider, 'replyToCommentThread' | 'getCommentThreads'>
        > &
            CodeForgeProvider;

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Sending reply...',
                    cancellable: false,
                },
                async () => {
                    await provider.replyToCommentThread(changeId, threadId, reply.text, resolved);
                    await this.refreshActiveChangeComments();
                    repo.codeForge.requestRefreshWithBackoffs();
                },
            );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to send reply: ${err}`);
        }
    }

    public async toggleResolveThread(thread: vscode.CommentThread, resolved: boolean): Promise<void> {
        const repo = this.repositoryManager.focusedRepository;
        const changeId = this.activeChangeId;
        if (!repo || !changeId) {
            return;
        }

        const { activeProvider } = repo.codeForge;
        if (!activeProvider?.resolveCommentThread || !activeProvider.getCommentThreads) {
            return;
        }

        let foundThreadId: string | undefined;
        for (const [id, t] of this.threads.entries()) {
            if (t === thread) {
                foundThreadId = id;
                break;
            }
        }

        if (!foundThreadId) {
            return;
        }

        const threadId = foundThreadId;
        const provider = activeProvider as Required<
            Pick<CodeForgeProvider, 'resolveCommentThread' | 'getCommentThreads'>
        > &
            CodeForgeProvider;

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: resolved ? 'Resolving thread...' : 'Unresolving thread...',
                    cancellable: false,
                },
                async () => {
                    await provider.resolveCommentThread(changeId, threadId, resolved);
                    await this.refreshActiveChangeComments();
                    repo.codeForge.requestRefreshWithBackoffs();
                },
            );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to toggle resolve: ${err}`);
        }
    }

    public async copyUnresolvedComments(): Promise<void> {
        const unresolvedThreads = Array.from(this.threads.values()).filter(
            (thread) => thread.state === vscode.CommentThreadState.Unresolved,
        );

        if (unresolvedThreads.length === 0) {
            vscode.window.showInformationMessage('No unresolved comments for the active change.');
            return;
        }

        unresolvedThreads.sort((a, b) => {
            const pathA = a.uri.fsPath;
            const pathB = b.uri.fsPath;
            if (pathA !== pathB) {
                return pathA.localeCompare(pathB);
            }
            const lineA = a.range?.start.line ?? 0;
            const lineB = b.range?.start.line ?? 0;
            return lineA - lineB;
        });

        const info = this.activeChangeInfo;
        let changeLabel = '';
        if (info) {
            changeLabel = ` for ${info.displayLabel}`;
        }

        let result = `### Unresolved Comments${changeLabel}\n\n`;

        for (const thread of unresolvedThreads) {
            const relativePath = vscode.workspace.asRelativePath(thread.uri);
            if (thread.range) {
                const lineNum = thread.range.start.line + 1;
                result += `- **${relativePath}:${lineNum}**\n`;
            } else {
                result += `- **${relativePath}**\n`;
            }
            for (const comment of thread.comments) {
                const author = comment.author?.name || 'Unknown';
                const body = typeof comment.body === 'string' ? comment.body : comment.body.value;
                const indentedBody = body
                    .split(/\r?\n/)
                    .map((line) => `    > ${line}`)
                    .join('\n');
                result += `  - **${author}**:\n${indentedBody}\n`;
            }
        }

        try {
            await vscode.env.clipboard.writeText(`${result.trim()}\n`);
            vscode.window.showInformationMessage(
                `Copied ${unresolvedThreads.length} unresolved comment(s) to clipboard.`,
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to copy comments to clipboard: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    public dispose() {
        if (this.activeLoadController) {
            this.activeLoadController.abort();
        }
        this.clearThreads();
        for (const d of this.repoDisposables) {
            d.dispose();
        }
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
