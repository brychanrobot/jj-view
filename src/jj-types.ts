/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface JjBookmark {
    name: string;
    remote?: string;
}

/**
 * Metadata retrieved from Gerrit about a specific Change.
 */
export interface GerritClInfo {
    /** The Gerrit Change-Id (e.g. I123...) */
    changeId: string;
    /** The Gerrit Change number (e.g. 123456) */
    changeNumber: number;
    /** Current status of the change in Gerrit */
    status: 'NEW' | 'MERGED' | 'ABANDONED';
    /** Whether the change is currently submittable according to Gerrit labels */
    submittable: boolean;
    /** The web URL to the Gerrit change */
    url: string;
    /** Number of unresolved comments on the change */
    unresolvedComments: number;
    /** The SHA-1 commit ID of the current revision in Gerrit */
    currentRevision?: string;
    /** Map of files in the current Gerrit revision and their blob SHAs */
    files?: Record<string, { newSha?: string; status?: string }>;
    /** Aggregate sync status (contentSynced && parentSynced) */
    synced?: boolean;
    /** Whether the Gerrit parent pointers match the latest patchsets of the local parents */
    parentSynced?: boolean;
    /** List of commit SHAs for the parents as recorded by Gerrit */
    gerritParents?: string[];
    /** The full commit message of the current revision in Gerrit */
    remoteDescription?: string;
    /** @deprecated Use gerritParents */
    remoteParentRevision?: string;
    /** Whether the file contents match exactly between local and Gerrit */
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
    gerritCl?: GerritClInfo;
    gerritNeedsUpload?: boolean;
}

export interface JjStatusEntry {
    path: string;
    oldPath?: string;
    status: 'modified' | 'added' | 'removed' | 'renamed' | 'copied' | 'deleted'; // 'deleted' is sometimes used for removed
    additions?: number;
    deletions?: number;
    conflicted?: boolean;
}

export type CommitAction = 'newChild' | 'edit' | 'squash' | 'abandon' | 'openGerrit' | 'upload';

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
