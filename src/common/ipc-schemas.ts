/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';
import { JjBookmarkSchema, JjLogEntrySchema, JjStatusEntrySchema } from '../jj-schemas';

export const ActionPayloadSchema = z.object({
    changeId: z.string(),
    isImmutable: z.boolean().optional(),
    url: z.string().optional(),
    multiSelect: z.boolean().optional(),
    changeIdShortest: z.string().optional(),
    isDivergent: z.boolean().optional(),
    changeIdOffset: z.number().optional(),
});
export type ActionPayload = z.infer<typeof ActionPayloadSchema>;

export const WebviewPayloadSchema = z.object({
    commits: z.array(JjLogEntrySchema).optional(),
    minChangeIdLength: z.number().optional(),
    theme: z.string().optional(),
    graphLabelAlignment: z.string().optional(),
    hiddenActions: z.array(z.string()).optional(),
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
    formatDescriptionOnSave: z.boolean().optional(),
});
export type WebviewPayload = z.infer<typeof WebviewPayloadSchema>;

export const WebviewToHostMessageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('webviewLoaded') }),
    z.object({ type: z.literal('newChild'), payload: ActionPayloadSchema }),
    z.object({ type: z.literal('edit'), payload: ActionPayloadSchema }),
    z.object({ type: z.literal('squash'), payload: ActionPayloadSchema }),
    z.object({ type: z.literal('abandon'), payload: ActionPayloadSchema }),
    z.object({ type: z.literal('select'), payload: ActionPayloadSchema }),
    z.object({ type: z.literal('undo') }),
    z.object({ type: z.literal('redo') }),
    z.object({ type: z.literal('getDetails'), payload: ActionPayloadSchema }),
    z.object({ type: z.literal('new') }),
    z.object({
        type: z.literal('newBefore'),
        payload: z.object({ changeIds: z.array(z.string()).optional() }),
    }),
    z.object({
        type: z.literal('newAfter'),
        payload: z.object({ changeIds: z.array(z.string()).optional() }),
    }),
    z.object({
        type: z.literal('resolve'),
        payload: z.object({ path: z.string() }),
    }),
    z.object({
        type: z.literal('moveBookmark'),
        payload: z.object({ bookmark: z.string(), targetChangeId: z.string() }),
    }),
    z.object({
        type: z.literal('rebaseCommit'),
        payload: z.object({
            sourceChangeId: z.string(),
            targetChangeId: z.string(),
            mode: z.enum(['revision', 'source']),
        }),
    }),
    z.object({
        type: z.literal('squashCommit'),
        payload: z.object({ sourceChangeId: z.string(), targetChangeId: z.string(), mode: z.enum(['into', 'onto']) }),
    }),
    z.object({
        type: z.literal('duplicateCommit'),
        payload: z.object({ sourceChangeId: z.string(), targetChangeId: z.string().optional() }),
    }),
    z.object({
        type: z.literal('mergeCommit'),
        payload: z.object({ sourceChangeId: z.string(), targetChangeId: z.string() }),
    }),
    z.object({ type: z.literal('upload'), payload: ActionPayloadSchema }),
    z.object({
        type: z.literal('showComments'),
        payload: z.object({ changeId: z.string() }),
    }),
    z.object({
        type: z.literal('selectionChange'),
        payload: z.object({ commitIds: z.array(z.string()), hasImmutableSelection: z.boolean().optional() }),
    }),
    z.object({
        type: z.literal('setContextKey'),
        payload: z.object({ key: z.string(), value: z.unknown() }),
    }),
    z.object({
        type: z.literal('openCodeForge'),
        payload: z.object({ url: z.string() }),
    }),
    z.object({
        type: z.literal('saveDescription'),
        payload: z.object({ changeId: z.string(), description: z.string() }),
    }),
    z.object({
        type: z.literal('descriptionChanged'),
        payload: z.object({
            description: z.string(),
            selectionStart: z.number().optional(),
            selectionEnd: z.number().optional(),
        }),
    }),
    z.object({
        type: z.literal('saveFileText'),
        payload: z.object({ filePath: z.string(), content: z.string() }),
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
export type WebviewToHostMessage = z.infer<typeof WebviewToHostMessageSchema>;

export const HostToWebviewMessageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('updateData'), payload: WebviewPayloadSchema.optional() }),
    z.object({ type: z.literal('updateDetails'), payload: WebviewPayloadSchema.optional() }),
    z.object({ type: z.literal('updateTheme'), payload: z.object({ theme: z.string() }) }),
    z.object({ type: z.literal('saveComplete'), payload: z.object({ description: z.string() }).optional() }),
    z.object({ type: z.literal('saveFailed') }),
]);
export type HostToWebviewMessage = z.infer<typeof HostToWebviewMessageSchema>;
