/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Event } from './host/events';
import type { CodeForgeChangeInfo, CommitParent } from './jj-types';

export interface GitRemote {
    name: string;
    url: string;
}

export interface ChangeStatusRequest {
    commitId: string;
    changeId?: string;
    description?: string;
    bookmarks?: string[];
    parents?: CommitParent[];
}

export interface CodeForgeProvider {
    /** Unique ID of the provider (e.g. 'gerrit', 'github') */
    readonly id: string;
    /** User-friendly display name (e.g. 'Gerrit', 'GitHub') */
    readonly displayName: string;
    /** Terminology used for change units (e.g. 'CL' for Gerrit, 'PR' for GitHub) */
    readonly changeTerm: 'CL' | 'PR' | 'Change';

    /** Fires when change cache statuses or states are updated */
    readonly onDidUpdate: Event<void>;

    /** Determines if this provider is active for the current workspace and remotes */
    detect(workspaceRoot: string, remotes: GitRemote[]): Promise<boolean>;

    /** Retrieves the cached status info for a given change */
    getCachedChangeInfo(changeId?: string, description?: string, bookmarks?: string[]): CodeForgeChangeInfo | undefined;

    /** Batch fetches statuses from the network. Returns true if any cache state changed */
    fetchStatuses(changes: ChangeStatusRequest[], jj: import('./jj-service').JjService): Promise<boolean>;

    /**
     * Resolves the jj upload subcommand and arguments for pushing code.
     * Return undefined if this provider does not support uploading code.
     */
    getUploadCommand?(revision: string, hasBookmark?: boolean): { subcommand: string; args: string[] } | undefined;

    /** Hook called when the provider starts or stops being the active provider */
    activate(): void;
    deactivate(): void;
    /** Hook to dispose provider resources */
    dispose?(): void;
    /** Hook to clear provider's cached data */
    clearCache(): void;
    /** Check if authentication is currently configured/available for this provider */
    hasAuth?(): Promise<boolean>;
    /** True if this provider supports managing authentication preferences/tokens */
    readonly isAuthManageable?: boolean;
    /** Returns custom authentication management items for this provider */
    getAuthManageItems?(): Promise<AuthManageItem[]>;

    /** Fetch all comment threads for a given change */
    getCommentThreads?(changeId: string, signal?: AbortSignal): Promise<CodeForgeCommentThread[]>;
    /** Reply to a comment thread */
    replyToCommentThread?(
        changeId: string,
        threadId: string,
        body: string,
        resolved?: boolean,
    ): Promise<CodeForgeComment>;
    /** Resolve/unresolve a comment thread */
    resolveCommentThread?(changeId: string, threadId: string, resolved: boolean): Promise<void>;
}

export interface CodeForgeComment {
    id: string;
    author: {
        name: string;
        username?: string;
        avatarUrl?: string;
    };
    body: string;
    createdAt: string;
    isDraft?: boolean;
}

export interface CodeForgeCommentThread {
    id: string;
    filePath?: string;
    line?: number;
    isResolved: boolean;
    comments: CodeForgeComment[];
}

export interface AuthManageItem {
    label: string;
    description?: string;
    detail?: string;
    picked?: boolean;
    alwaysShow?: boolean;
    execute(): Promise<void>;
}
