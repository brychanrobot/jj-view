/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface JjBookmark {
    name: string;
    remote?: string | null;
}

/**
 * Metadata retrieved from a code forge about a specific Change/PR.
 */
export interface CodeForgeChangeInfo {
    /** Unique identifier for the change (e.g. Gerrit Change-Id or GitHub PR node ID) */
    id: string;
    /** User-facing sequential number (e.g. Gerrit change number or GitHub PR number) */
    number: number;
    /** The display label (e.g. "CL 123456" or "PR #42") */
    displayLabel: string;
    /** Human-readable provider name (e.g. "Gerrit" or "GitHub") */
    providerName: string;
    /** Standardized status across forges */
    status: 'NEW' | 'MERGED' | 'ABANDONED';
    /** Whether the change is currently submittable/mergeable */
    submittable: boolean;
    /** The web URL to the change/PR */
    url: string;
    /** Number of unresolved comments/discussions */
    unresolvedComments: number;
    /** The commit ID of the current remote revision */
    currentRevision?: string;
    /** Map of files in the current remote revision and their blob SHAs */
    files?: Record<string, { newSha?: string; status?: string }>;
    /** Aggregate sync status (contentSynced && parentSynced) */
    synced?: boolean;
    /** Whether the remote parent pointers match the latest patchsets of the local parents */
    parentSynced?: boolean;
    /** List of commit SHAs for the parents as recorded by the remote */
    remoteParents?: string[];
    /** The full commit message of the current remote revision */
    remoteDescription?: string;
    /** Whether the file contents match exactly between local and remote */
    contentSynced?: boolean;
}

/**
 * Metadata about a commit's parent, retrieved from jj.
 */
export interface CommitParent {
    /** The SHA-1 commit ID of the parent revision. */
    commit_id: string;
    /** The jj change ID of the parent revision (e.g. 'qutpskpt'). */
    change_id: string;
    /** Whether the parent is an immutable revision (e.g. main@origin). */
    is_immutable: boolean;
}

export interface JjLogEntry {
    commit_id: string;
    change_id: string;
    change_id_shortest?: string;
    description: string;
    author: {
        name: string;
        email: string;
        timestamp: string;
    };
    committer: {
        name: string;
        email: string;
        timestamp: string;
    };
    parents: CommitParent[];
    nearest_visible_ancestors?: string[];
    bookmarks?: JjBookmark[];
    tags?: string[];
    working_copies?: string[];
    is_current_working_copy?: boolean;
    is_immutable?: boolean;
    is_empty?: boolean;
    is_divergent?: boolean;
    change_id_offset?: number;
    conflict?: boolean;
    is_hidden?: boolean;
    changes?: JjStatusEntry[];
    codeForgeChange?: CodeForgeChangeInfo;
    codeForgeNeedsUpload?: boolean;
}

export interface JjStatusEntry {
    path: string;
    oldPath?: string;
    status: 'modified' | 'added' | 'removed' | 'renamed' | 'copied' | 'deleted'; // 'deleted' is sometimes used for removed
    additions?: number;
    deletions?: number;
    conflicted?: boolean;
}

export type CommitAction = 'newChild' | 'edit' | 'squash' | 'abandon' | 'openCodeForge' | 'upload';

export const TOGGLEABLE_COMMIT_ACTIONS = ['newChild', 'edit', 'squash', 'abandon'] as const;
export type ToggleableCommitAction = (typeof TOGGLEABLE_COMMIT_ACTIONS)[number];

export interface ActionPayload {
    changeId: string;
    isImmutable?: boolean;
    url?: string;
    multiSelect?: boolean;
    changeIdShortest?: string;
    isDivergent?: boolean;
    changeIdOffset?: number;
}

/** Payload for the initial webview load */
export interface WebviewPayload {
    commits?: JjLogEntry[];
    minChangeIdLength?: number;
    theme?: string;
    graphLabelAlignment?: string;
    hiddenActions?: CommitAction[];
    // Details fields
    changeId?: string;
    commitId?: string;
    description?: string;
    files?: JjStatusEntry[];
    isImmutable?: boolean;
    isEmpty?: boolean;
    isConflict?: boolean;
    author?: { name: string; email: string; timestamp: string };
    committer?: { name: string; email: string; timestamp: string };
    bookmarks?: JjBookmark[];
    tags?: string[];
    titleWidthRuler?: number;
    bodyWidthRuler?: number;
    formatDescriptionOnSave?: boolean;
}

export interface WebviewInitialData {
    view: 'graph' | 'details';
    payload?: WebviewPayload;
}
