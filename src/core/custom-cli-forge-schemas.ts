/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';

export const CliForgeDetectResultSchema = z.object({
    detected: z.boolean(),
    id: z.string().min(1).default('custom'),
    displayName: z.string().min(1).default('Custom Forge'),
    changeTerm: z.enum(['CL', 'PR', 'Change']).default('CL'),
    uploadModel: z.enum(['revision', 'branch', 'branch-stack']).default('revision'),
    managedBookmarkPattern: z
        .string()
        .min(1)
        .refine(
            (pattern) => {
                try {
                    new RegExp(pattern);
                    return true;
                } catch {
                    return false;
                }
            },
            { message: 'Invalid regular expression pattern' },
        )
        .optional(),
});
export type CliForgeDetectResult = z.infer<typeof CliForgeDetectResultSchema>;

export const CliForgeChangeInfoSchema = z.object({
    id: z.string(),
    number: z.number().int().optional(),
    url: z.string(),
    displayLabel: z.string().optional(),
    title: z.string().optional(),
    status: z.enum(['NEW', 'MERGED', 'ABANDONED']).optional(),
    submittable: z.boolean().optional(),
    unresolvedComments: z.number().int().nonnegative().optional(),
    hasDraftComments: z.boolean().optional(),
    contentSynced: z.boolean().optional(),
    parentSynced: z.boolean().optional(),
    synced: z.boolean().optional(),
    currentRevision: z.string().optional(),
    remoteParents: z.array(z.string()).optional(),
});
export type CliForgeChangeInfo = z.infer<typeof CliForgeChangeInfoSchema>;

export const CliForgeStatusRowSchema = z.object({
    commitId: z.string(),
    changeId: z.string(),
    info: CliForgeChangeInfoSchema.nullable().optional(),
});
export type CliForgeStatusRow = z.infer<typeof CliForgeStatusRowSchema>;

export const CliForgeCommentSchema = z.object({
    id: z.string(),
    author: z.object({
        name: z.string(),
        username: z.string().optional(),
        avatarUrl: z.string().optional(),
    }),
    body: z.string(),
    createdAt: z.string(),
    isDraft: z.boolean().optional(),
});
export type CliForgeComment = z.infer<typeof CliForgeCommentSchema>;

export const CliForgeCommentThreadMetadataSchema = z.object({
    side: z.enum(['PARENT', 'REVISION']).optional(),
    commitId: z.string().optional(),
    originalLine: z.number().int().nonnegative().optional(),
    portedLine: z.number().int().nonnegative().optional(),
    patchSet: z.number().int().positive().optional(),
});
export type CliForgeCommentThreadMetadata = z.infer<typeof CliForgeCommentThreadMetadataSchema>;

export const CliForgeCommentThreadSchema = z.object({
    id: z.string(),
    filePath: z.string().optional(),
    line: z.number().int().nonnegative().optional(),
    isResolved: z.boolean(),
    metadata: CliForgeCommentThreadMetadataSchema.optional(),
    comments: z.array(CliForgeCommentSchema),
});
export type CliForgeCommentThread = z.infer<typeof CliForgeCommentThreadSchema>;
