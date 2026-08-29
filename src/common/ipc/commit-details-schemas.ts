/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';
import { JjBookmarkSchema, JjStatusEntrySchema } from '../../jj-schemas';

export const CommitDetailsToHostMessageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('webviewLoaded') }),
    z.object({
        type: z.literal('descriptionChanged'),
        payload: z.object({
            description: z.string(),
            selectionStart: z.number().optional(),
            selectionEnd: z.number().optional(),
        }),
    }),
    z.object({
        type: z.literal('saveDescription'),
        payload: z.object({
            changeId: z.string(),
            description: z.string(),
        }),
    }),
    z.object({
        type: z.literal('openDiff'),
        payload: z.object({
            file: JjStatusEntrySchema,
            changeId: z.string(),
            isImmutable: z.boolean().optional(),
        }),
    }),
    z.object({
        type: z.literal('openMultiDiff'),
        payload: z.object({
            changeId: z.string(),
        }),
    }),
]);
export type CommitDetailsToHostMessage = z.infer<typeof CommitDetailsToHostMessageSchema>;

export const CommitDetailsPayloadSchema = z.object({
    changeId: z.string().optional(),
    commitId: z.string().optional(),
    description: z.string().optional(),
    files: z.array(JjStatusEntrySchema).optional(),
    isImmutable: z.boolean().optional(),
    isEmpty: z.boolean().optional(),
    isConflict: z.boolean().optional(),
    author: z
        .object({
            name: z.string(),
            email: z.string(),
            timestamp: z.string(),
        })
        .optional(),
    committer: z
        .object({
            name: z.string(),
            email: z.string(),
            timestamp: z.string(),
        })
        .optional(),
    bookmarks: z.array(JjBookmarkSchema).optional(),
    tags: z.array(z.string()).optional(),
    titleWidthRuler: z.number().optional(),
    bodyWidthRuler: z.number().optional(),
    minChangeIdLength: z.number().optional(),
    theme: z.string().optional(),
    formatDescriptionOnSave: z.boolean().optional(),
});
export type CommitDetailsPayload = z.infer<typeof CommitDetailsPayloadSchema>;

export const CommitDetailsHostToWebviewMessageSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('updateDetails'),
        payload: CommitDetailsPayloadSchema,
    }),
    z.object({
        type: z.literal('saveComplete'),
        payload: z.object({
            description: z.string(),
        }),
    }),
    z.object({
        type: z.literal('saveFailed'),
    }),
    z.object({
        type: z.literal('updateDescription'),
        payload: z.object({
            description: z.string(),
            selectionStart: z.number().optional(),
            selectionEnd: z.number().optional(),
        }),
    }),
]);
export type CommitDetailsHostToWebviewMessage = z.infer<typeof CommitDetailsHostToWebviewMessageSchema>;
