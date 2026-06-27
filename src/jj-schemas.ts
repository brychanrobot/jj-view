/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';

export const JjBookmarkSchema = z.object({
    /** The name of the Jujutsu bookmark. */
    name: z.string(),
    /** The optional name of the remote tracking branch or null. */
    remote: z.string().nullable().optional(),
});
export type JjBookmark = z.infer<typeof JjBookmarkSchema>;

export const JjWorkspaceSchema = z.object({
    /** The name of the Jujutsu workspace. */
    name: z.string(),
    /** The filesystem path to the workspace root. */
    path: z.string(),
});
export type JjWorkspace = z.infer<typeof JjWorkspaceSchema>;

export const CommitParentSchema = z.object({
    /** The SHA-1 commit ID of the parent revision. */
    commit_id: z.string(),
    /** The jj change ID of the parent revision (e.g. 'qutpskpt'). */
    change_id: z.string(),
    /** Whether the parent is an immutable revision (e.g. main@origin). */
    is_immutable: z.boolean(),
});
export type CommitParent = z.infer<typeof CommitParentSchema>;

export const JjStatusEntrySchema = z.object({
    /** The relative path of the file modified. */
    path: z.string(),
    /** The old path if the file was renamed or copied. */
    oldPath: z.string().optional(),
    /** The operation type performed on the file. */
    status: z.enum(['modified', 'added', 'removed', 'renamed', 'copied', 'deleted']),
    /** The number of added lines. */
    additions: z.number().optional(),
    /** The number of deleted lines. */
    deletions: z.number().optional(),
    /** Whether the file is currently conflicted. */
    conflicted: z.boolean().optional(),
});
export type JjStatusEntry = z.infer<typeof JjStatusEntrySchema>;

/**
 * Metadata retrieved from a code forge about a specific Change/PR.
 */
export const CodeForgeChangeInfoSchema = z.object({
    /** Unique identifier for the change (e.g. Gerrit Change-Id or GitHub PR node ID) */
    id: z.string(),
    /** User-facing sequential number (e.g. Gerrit change number or GitHub PR number) */
    number: z.number(),
    /** The display label (e.g. "CL 123456" or "PR #42") */
    displayLabel: z.string(),
    /** Human-readable provider name (e.g. "Gerrit" or "GitHub") */
    providerName: z.string(),
    /** Standardized status across forges */
    status: z.enum(['NEW', 'MERGED', 'ABANDONED']),
    /** Whether the change is currently submittable/mergeable */
    submittable: z.boolean(),
    /** The web URL to the change/PR */
    url: z.string(),
    /** Number of unresolved comments/discussions */
    unresolvedComments: z.number(),
    /** The commit ID of the current remote revision */
    currentRevision: z.string().optional(),
    /** Map of files in the current remote revision and their blob SHAs */
    files: z
        .record(
            z.string(),
            z.object({
                newSha: z.string().optional(),
                status: z.string().optional(),
            }),
        )
        .optional(),
    /** Aggregate sync status (contentSynced && parentSynced) */
    synced: z.boolean().optional(),
    /** Whether the remote parent pointers match the latest patchsets of the local parents */
    parentSynced: z.boolean().optional(),
    /** List of commit SHAs for the parents as recorded by the remote */
    remoteParents: z.array(z.string()).optional(),
    /** The full commit message of the current remote revision */
    remoteDescription: z.string().optional(),
    /** Whether the file contents match exactly between local and remote */
    contentSynced: z.boolean().optional(),
});
export type CodeForgeChangeInfo = z.infer<typeof CodeForgeChangeInfoSchema>;

export const JjLogEntrySchema = z.object({
    /** The unique SHA-1 identifier for the commit. */
    commit_id: z.string(),
    /** The stable change ID (retains value across history rewrites). */
    change_id: z.string(),
    /** The shortest unique prefix of the change ID. */
    change_id_shortest: z.string().optional(),
    /** The description (commit message). */
    description: z.string(),
    /** Details of the revision author. */
    author: z.object({
        /** The author's name. */
        name: z.string(),
        /** The author's email address. */
        email: z.string(),
        /** The creation timestamp. */
        timestamp: z.string(),
    }),
    /** Details of the committer. */
    committer: z.object({
        /** The committer's name. */
        name: z.string(),
        /** The committer's email address. */
        email: z.string(),
        /** The commit timestamp. */
        timestamp: z.string(),
    }),
    /** The parents of the commit revision. */
    parents: z.array(CommitParentSchema),
    /** Nearest ancestors that are visible in the graph. */
    nearest_visible_ancestors: z.array(z.string()).optional(),
    /** Bookmarks pointing to this revision. */
    bookmarks: z.array(JjBookmarkSchema).optional(),
    /** Tags pointing to this revision. */
    tags: z.array(z.string()).optional(),
    /** Names of the working copies using this revision. */
    working_copies: z.array(z.string()).optional(),
    /** Whether this revision is the current working copy. */
    is_current_working_copy: z.boolean().optional(),
    /** Whether this commit revision is immutable. */
    is_immutable: z.boolean().optional(),
    /** Whether the revision contains no changes (empty). */
    is_empty: z.boolean().optional(),
    /** Whether the change ID is divergent (points to multiple commits). */
    is_divergent: z.boolean().optional(),
    /** Offset modifier for divergent change IDs. */
    change_id_offset: z.number().optional(),
    /** Whether this revision has merge conflicts. */
    conflict: z.boolean().optional(),
    /** Whether this revision is hidden in the jujutsu log. */
    is_hidden: z.boolean().optional(),
    /** Modified files within this commit revision. */
    changes: z.array(JjStatusEntrySchema).optional(),
    /** Associated Code Forge change metadata. */
    codeForgeChange: CodeForgeChangeInfoSchema.optional(),
    /** Whether the local changes need to be uploaded to the code forge. */
    codeForgeNeedsUpload: z.boolean().optional(),
});
export type JjLogEntry = z.infer<typeof JjLogEntrySchema>;
