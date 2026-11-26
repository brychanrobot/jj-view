/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';
import type { HostPlatform } from './host/host-system';
import { normalizeRepoSeparators } from './path-utils';

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
    /** The filesystem path to the workspace root (empty if unrecorded or stale). */
    path: z
        .string()
        .nullable()
        .transform((val) => val ?? ''),
    /** The full change ID of the workspace's working-copy commit. */
    change_id: z.string().optional(),
    /** The shortest unique prefix of the workspace's working-copy change ID. */
    change_id_shortest: z.string().optional(),
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

/**
 * Normalizes backslashes in relative file paths to forward slashes strictly on Windows hosts.
 */
export function normalizePath(val: unknown, platform?: HostPlatform | string): unknown {
    if (typeof val === 'string') {
        return normalizeRepoSeparators(val, platform);
    }
    return val;
}

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
    /** Number of draft comments/discussions pending publication (top-level, not in reply to an existing thread) */
    draftComments: z.number().optional(),
    /** Number of draft replies addressing comments */
    draftResponses: z.number().optional(),
    /** Number of unique unresolved comment threads that have at least one draft reply */
    addressedThreads: z.number().optional(),
    /** Whether there are any draft responses addressing comments */
    hasDraftResponses: z.boolean().optional(),
    /** The commit ID of the current remote revision */
    currentRevision: z.string().optional(),
    /** Map of files in the current remote revision and their blob SHAs */
    files: z
        .record(
            z.string(),
            z.object({
                newSha: z.string().optional(),
                status: z.string().optional(),
                oldPath: z.string().optional(),
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
    /** The base commit SHA of the PR/MR/change on the remote forge */
    remoteBaseRevision: z.string().optional(),
    /** The target/base branch name of the PR/MR on the remote forge */
    remoteBaseRefName: z.string().optional(),
    /** Whether the file contents match exactly between local and remote */
    contentSynced: z.boolean().optional(),
});
export type CodeForgeChangeInfo = z.infer<typeof CodeForgeChangeInfoSchema>;

/**
 * Creates Zod schemas whose path fields normalize `\` -> `/` only for the specified host platform.
 */
export function createJjOutputSchemas(platform?: HostPlatform | string) {
    const normalizedPath = z.preprocess((val) => normalizePath(val, platform), z.string());

    const fileChange = z.object({
        /** The relative path of the file modified. */
        path: normalizedPath,
        /** The old path if the file was renamed or copied. */
        oldPath: normalizedPath.optional(),
        /** The operation type performed on the file. */
        status: z.enum(['modified', 'added', 'renamed', 'copied', 'deleted']),
        /** Whether the file is currently conflicted. */
        conflicted: z.boolean().optional(),
        /** The number of conflicting sides (e.g. 2 for standard conflict, 3+ for multi-way merge). */
        conflictSides: z.number().optional(),
    });

    const fileChangeWithStats = fileChange.extend({
        /** The number of added lines. */
        additions: z.number().optional(),
        /** The number of deleted lines. */
        deletions: z.number().optional(),
    });

    const diffStatEntry = z.object({
        path: normalizedPath,
        additions: z.number().default(0),
        deletions: z.number().default(0),
    });

    const conflictedFileEntry = z.object({
        path: normalizedPath,
        conflictSides: z.number().optional(),
    });

    const changesAndStatsOutput = z.object({
        changes: z.array(fileChange).default([]),
        stats: z.array(diffStatEntry).default([]),
        conflicts: z.array(conflictedFileEntry).default([]),
    });

    const logEntry = z.object({
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
        bookmarks: z.array(JjBookmarkSchema).default([]),
        /** Tags pointing to this revision. */
        tags: z.array(z.string()).optional(),
        /** Names of the working copies using this revision. */
        working_copies: z.array(z.string()).optional(),
        /** Whether this revision is the current working copy. */
        is_current_working_copy: z.boolean().optional(),
        /** Whether this commit revision is immutable. */
        is_immutable: z.boolean().optional(),
        /** Whether this commit is the repository root commit (`root()`). */
        is_root: z.boolean().optional(),
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
        changes: z.array(fileChangeWithStats).optional(),
        /** Associated Code Forge change metadata. */
        codeForgeChange: CodeForgeChangeInfoSchema.optional(),
        /** Whether the local changes need to be uploaded to the code forge. */
        codeForgeNeedsUpload: z.boolean().optional(),
    });

    return {
        normalizedPath,
        fileChange,
        fileChangeWithStats,
        diffStatEntry,
        conflictedFileEntry,
        changesAndStatsOutput,
        logEntry,
    };
}

const defaultOutputSchemas = createJjOutputSchemas();

export const NormalizedPathSchema = defaultOutputSchemas.normalizedPath;

export const JjFileChangeSchema = defaultOutputSchemas.fileChange;
export type JjFileChange = z.infer<typeof JjFileChangeSchema>;

export const JjFileChangeWithStatsSchema = defaultOutputSchemas.fileChangeWithStats;
export type JjFileChangeWithStats = z.infer<typeof JjFileChangeWithStatsSchema>;

/** Legacy alias for JjFileChangeWithStats */
export const JjStatusEntrySchema = JjFileChangeWithStatsSchema;
export type JjStatusEntry = JjFileChangeWithStats;

export const DiffStatEntrySchema = defaultOutputSchemas.diffStatEntry;
export type DiffStatEntry = z.infer<typeof DiffStatEntrySchema>;

export const ConflictedFileEntrySchema = defaultOutputSchemas.conflictedFileEntry;
export type ConflictedFileEntry = z.infer<typeof ConflictedFileEntrySchema>;

export const ChangesAndStatsOutputSchema = defaultOutputSchemas.changesAndStatsOutput;
export type ChangesAndStatsOutput = z.infer<typeof ChangesAndStatsOutputSchema>;

export const JjLogEntrySchema = defaultOutputSchemas.logEntry;
export type JjLogEntry = z.infer<typeof JjLogEntrySchema>;
