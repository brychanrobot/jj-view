/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface JjBookmark {
    name: string;
    remote?: string;
}

export interface GerritClInfo {
    changeId: string;
    changeNumber: number;
    status: 'NEW' | 'MERGED' | 'ABANDONED';
    submittable: boolean;
    url: string;
    unresolvedComments: number;
    currentRevision?: string;
    files?: Record<string, { newSha?: string; status?: string }>;
    synced?: boolean;
    remoteDescription?: string;
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
    parents: string[];
    parent_change_ids?: string[];
    nearest_visible_ancestors?: string[];
    bookmarks?: JjBookmark[];
    tags?: string[];
    working_copies?: string[];
    is_current_working_copy?: boolean;
    is_immutable?: boolean;
    is_empty?: boolean;
    is_divergent?: boolean;
    change_id_offset?: number;
    parents_immutable?: boolean[];
    conflict?: boolean;
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
