/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mount, unmount } from 'svelte';
import CommentThreadView from './CommentThreadView.svelte';
import type { CommentThreadHandle } from './comments-store.svelte';

export interface ThreadAnnotationCallbacks {
    onReply?: (handle: CommentThreadHandle, text: string, resolve: boolean) => Promise<void>;
    onSetResolved?: (handle: CommentThreadHandle, resolved: boolean) => Promise<void>;
}

/**
 * Owns the {@link CommentThreadView} components mounted into Pierre's
 * annotation slots. Pierre calls `renderAnnotation` whenever it (re)creates a
 * slot and only ever removes the wrapper element afterwards, so the Svelte
 * component behind each slot has to be unmounted here, keyed by thread id.
 */
export class ThreadAnnotationMounts {
    private readonly mounted = new Map<string, ReturnType<typeof mount>>();

    constructor(private readonly callbacks: ThreadAnnotationCallbacks) {}

    /** Creates the annotation element for `handle`, replacing any earlier mount for the same thread. */
    render(handle: CommentThreadHandle): HTMLElement {
        this.unmount(handle.id);
        const target = document.createElement('div');
        target.className = 'diff-comment-annotation';
        target.dataset.testid = 'diff-comment-annotation';
        target.dataset.threadId = handle.id;
        const instance = mount(CommentThreadView, {
            target,
            props: {
                handle,
                variant: 'inline',
                onReply: (text: string, resolve: boolean) =>
                    this.callbacks.onReply?.(handle, text, resolve) ?? Promise.resolve(),
                onSetResolved: (resolved: boolean) =>
                    this.callbacks.onSetResolved?.(handle, resolved) ?? Promise.resolve(),
            },
        });
        this.mounted.set(handle.id, instance);
        return target;
    }

    unmount(threadId: string): void {
        const instance = this.mounted.get(threadId);
        if (!instance) {
            return;
        }
        this.mounted.delete(threadId);
        void unmount(instance);
    }

    /** Unmounts every view whose thread is no longer in `liveThreadIds`. */
    retainOnly(liveThreadIds: ReadonlySet<string>): void {
        for (const threadId of [...this.mounted.keys()]) {
            if (!liveThreadIds.has(threadId)) {
                this.unmount(threadId);
            }
        }
    }

    unmountAll(): void {
        this.retainOnly(new Set());
    }
}
