/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';
import { JjStatusEntrySchema } from '../../jj-schemas';
import { WebviewPayloadSchema } from './log-view-schemas';

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
        payload: z.object({ changeId: z.string(), description: z.string() }),
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
        payload: z.object({ changeId: z.string() }),
    }),
]);
export type CommitDetailsToHostMessage = z.infer<typeof CommitDetailsToHostMessageSchema>;

export const CommitDetailsHostToWebviewMessageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('updateDetails'), payload: WebviewPayloadSchema }),
    z.object({ type: z.literal('saveComplete'), payload: z.object({ description: z.string() }) }),
    z.object({ type: z.literal('saveFailed') }),
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
