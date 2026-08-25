/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CodeForgeComment, CodeForgeCommentThread } from '../../code-forge-provider';
import type { CommentsManager } from '../../comments-manager';
import { Uri } from '../../uri-utils';

function resolveThreadUri(filePath: string, activeRepoPath: string): Uri {
    if (path.isAbsolute(filePath)) {
        return Uri.file(filePath);
    }
    return Uri.file(path.join(activeRepoPath, filePath));
}

export class VsCodeCommentsProvider implements vscode.Disposable {
    private readonly commentController: vscode.CommentController;
    private readonly threads = new Map<string, vscode.CommentThread>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly commentsManager: CommentsManager) {
        this.commentController = vscode.comments.createCommentController('jj-view.comments', 'JJ Comments');
        this.disposables.push(this.commentController);

        this.commentController.commentingRangeProvider = {
            provideCommentingRanges: () => undefined,
        };

        this.disposables.push(
            this.commentsManager.onDidChangeThreads((threads) => {
                this.updateCommentThreads(threads, this.commentsManager.currentRepoPath);
            }),
        );

        if (this.commentsManager.threads.length > 0) {
            this.updateCommentThreads(this.commentsManager.threads, this.commentsManager.currentRepoPath);
        }
    }

    public getThreads(): Map<string, vscode.CommentThread> {
        return this.threads;
    }

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

    private syncCommentThread(thread: CodeForgeCommentThread, activeRepoPath: string): vscode.CommentThread {
        const fileUri = resolveThreadUri(thread.filePath ?? '', activeRepoPath);
        const line = Math.max(0, (thread.line ?? 1) - 1);
        const range = new vscode.Range(line, 0, line, 0);

        const comments = thread.comments.map((c) => this.mapToVscodeComment(c));

        const expectedCollapsibleState = thread.isResolved
            ? vscode.CommentThreadCollapsibleState.Collapsed
            : vscode.CommentThreadCollapsibleState.Expanded;
        const expectedContextValue = `${thread.isResolved ? 'resolved' : 'unresolved'}:${thread.id}`;

        let vscodeThread = this.threads.get(thread.id);
        if (!vscodeThread) {
            vscodeThread = this.commentController.createCommentThread(fileUri, range, comments);
            vscodeThread.canReply = true;
            vscodeThread.collapsibleState = expectedCollapsibleState;
            this.threads.set(thread.id, vscodeThread);
        } else {
            vscodeThread.comments = comments;
            vscodeThread.range = range;
            const previousResolved = vscodeThread.contextValue?.startsWith('resolved:');
            if (previousResolved !== thread.isResolved) {
                vscodeThread.collapsibleState = expectedCollapsibleState;
            }
        }

        vscodeThread.contextValue = expectedContextValue;
        vscodeThread.state = thread.isResolved
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;

        return vscodeThread;
    }

    private updateCommentThreads(threadsList: readonly CodeForgeCommentThread[], activeRepoPath?: string): void {
        if (!activeRepoPath || threadsList.length === 0) {
            this.clearThreads();
            return;
        }

        const activeThreadIds = new Set<string>();

        for (const thread of threadsList) {
            if (!thread.filePath || thread.line === undefined) {
                continue;
            }

            activeThreadIds.add(thread.id);
            this.syncCommentThread(thread, activeRepoPath);
        }

        // Dispose threads that are no longer active
        for (const [id, thread] of this.threads.entries()) {
            if (!activeThreadIds.has(id)) {
                thread.dispose();
                this.threads.delete(id);
            }
        }
    }

    private clearThreads(): void {
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
    }

    public dispose(): void {
        this.clearThreads();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
    }
}
