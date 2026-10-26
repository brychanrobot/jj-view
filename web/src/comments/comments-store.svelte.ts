/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'pathe';
import type { CodeForgeCommentThread } from '../../../src/core/code-forge-provider';
import type { CommentsManager } from '../../../src/core/comments-manager';
import type { Disposable } from '../../../src/core/host/events';
import type { CodeForgeChangeInfo } from '../../../src/core/jj-types';

/**
 * A stable, reactive handle for one comment thread.
 *
 * The forge providers return fresh thread objects on every poll. Consumers that
 * key long-lived UI on a thread (the diff viewer mounts one component per
 * annotation) need an identity that survives refreshes, so the store keeps one
 * handle per thread id and swaps the `thread` inside it.
 */
export class CommentThreadHandle {
    thread: CodeForgeCommentThread;

    constructor(
        readonly id: string,
        thread: CodeForgeCommentThread,
    ) {
        this.thread = $state.raw(thread);
    }
}

/** Repo-relative, forward-slash path for a thread, or undefined for change-level threads. */
export function normalizeThreadPath(filePath: string | undefined, repoPath: string | undefined): string | undefined {
    if (!filePath) {
        return undefined;
    }
    const relative = path.isAbsolute(filePath) && repoPath ? path.relative(repoPath, filePath) : filePath;
    return relative.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Mirrors {@link CommentsManager} into Svelte state for the web UI.
 */
export class CommentsStore implements Disposable {
    handles = $state.raw<readonly CommentThreadHandle[]>([]);
    activeChange = $state.raw<CodeForgeChangeInfo | undefined>(undefined);
    jjChangeId = $state.raw<string | undefined>(undefined);
    repoPath = $state.raw<string | undefined>(undefined);

    private readonly handlesById = new Map<string, CommentThreadHandle>();
    private readonly subscription: Disposable;

    constructor(readonly manager: CommentsManager) {
        this.subscription = manager.onDidChangeThreads((threads) => this.apply(threads));
        this.apply(manager.threads);
    }

    get unresolvedCount(): number {
        return this.handles.filter((h) => !h.thread.isResolved).length;
    }

    /** Handles for threads anchored to `relativePath` (repo-relative). */
    handlesForFile(relativePath: string): CommentThreadHandle[] {
        const wanted = normalizeThreadPath(relativePath, undefined);
        if (!wanted) {
            return [];
        }
        return this.handles.filter((h) => normalizeThreadPath(h.thread.filePath, this.repoPath) === wanted);
    }

    private apply(threads: readonly CodeForgeCommentThread[]): void {
        const seen = new Set<string>();
        const next: CommentThreadHandle[] = [];
        for (const thread of threads) {
            seen.add(thread.id);
            const existing = this.handlesById.get(thread.id);
            if (existing) {
                existing.thread = thread;
                next.push(existing);
                continue;
            }
            const handle = new CommentThreadHandle(thread.id, thread);
            this.handlesById.set(thread.id, handle);
            next.push(handle);
        }
        for (const id of this.handlesById.keys()) {
            if (!seen.has(id)) {
                this.handlesById.delete(id);
            }
        }
        this.handles = next;
        this.activeChange = this.manager.activeChange;
        this.jjChangeId = this.manager.currentJjChangeId;
        this.repoPath = this.manager.currentRepoPath;
    }

    dispose(): void {
        this.subscription.dispose();
        this.handlesById.clear();
        this.handles = [];
    }
}
