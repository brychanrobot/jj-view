/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

export const JjBookmarkSchema = z.object({
    name: z.string(),
    remote: z.string().nullable().optional(),
});
export type JjBookmark = z.infer<typeof JjBookmarkSchema>;

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
export const CommitParentSchema = z.object({
    commit_id: z.string(),
    change_id: z.string(),
    is_immutable: z.boolean(),
});
export type CommitParent = z.infer<typeof CommitParentSchema>;

export const JjStatusEntrySchema = z.object({
    path: z.string(),
    oldPath: z.string().optional(),
    status: z.enum(['modified', 'added', 'removed', 'renamed', 'copied', 'deleted']),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    conflicted: z.boolean().optional(),
});
export type JjStatusEntry = z.infer<typeof JjStatusEntrySchema>;

// CodeForgeChangeInfoSchema requires definition or we can just accept unknown/any for now since we don't parse it directly from jj, it is hydrated later.
// We'll leave it as any in the schema and type it properly.

export const JjLogEntrySchema = z.object({
    commit_id: z.string(),
    change_id: z.string(),
    change_id_shortest: z.string().optional(),
    description: z.string(),
    author: z.object({
        name: z.string(),
        email: z.string(),
        timestamp: z.string(),
    }),
    committer: z.object({
        name: z.string(),
        email: z.string(),
        timestamp: z.string(),
    }),
    parents: z.array(CommitParentSchema),
    nearest_visible_ancestors: z.array(z.string()).optional(),
    bookmarks: z.array(JjBookmarkSchema).optional(),
    tags: z.array(z.string()).optional(),
    working_copies: z.array(z.string()).optional(),
    is_current_working_copy: z.boolean().optional(),
    is_immutable: z.boolean().optional(),
    is_empty: z.boolean().optional(),
    is_divergent: z.boolean().optional(),
    change_id_offset: z.number().optional(),
    conflict: z.boolean().optional(),
    is_hidden: z.boolean().optional(),
    changes: z.array(JjStatusEntrySchema).optional(),
    codeForgeChange: z.any().optional(), // Hydrated later, not in raw JSON
    codeForgeNeedsUpload: z.boolean().optional(), // Hydrated later
});
export type JjLogEntry = z.infer<typeof JjLogEntrySchema> & { codeForgeChange?: CodeForgeChangeInfo };

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
