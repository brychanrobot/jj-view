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
    bookmarks?: JjBookmark[];
    is_working_copy?: boolean;
    is_immutable?: boolean;
    is_empty?: boolean;
    parents_immutable?: boolean[];
    conflict?: boolean;
    changes?: JjStatusEntry[];
    gerritCl?: GerritClInfo;
}

export interface JjStatusEntry {
    path: string;
    oldPath?: string;
    status: 'modified' | 'added' | 'removed' | 'renamed' | 'copied' | 'deleted'; // 'deleted' is sometimes used for removed
    additions?: number;
    deletions?: number;
    conflicted?: boolean;
}
