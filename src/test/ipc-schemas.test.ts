/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
    CommitDetailsHostToWebviewMessageSchema,
    CommitDetailsToHostMessageSchema,
} from '../core/host/ipc/commit-details-schemas';
import {
    CommitActionSchema,
    LogViewHostToWebviewMessageSchema,
    LogViewToHostMessageSchema,
} from '../core/host/ipc/log-view-schemas';
import {
    ProcessMonitorHostToWebviewMessageSchema,
    ProcessMonitorToHostMessageSchema,
} from '../core/host/ipc/process-monitor-schemas';

describe('IPC Schemas Unit Tests', () => {
    describe('LogView Schemas', () => {
        it('validates CommitAction enum', () => {
            const validActions = ['newChild', 'edit', 'squash', 'abandon', 'openCodeForge', 'upload'];
            for (const action of validActions) {
                expect(CommitActionSchema.safeParse(action).success).toBe(true);
            }
            expect(CommitActionSchema.safeParse('invalidAction').success).toBe(false);
        });

        it('validates all LogViewToHostMessage variants', () => {
            expect(LogViewToHostMessageSchema.safeParse({ type: 'webviewLoaded' }).success).toBe(true);
            expect(LogViewToHostMessageSchema.safeParse({ type: 'new' }).success).toBe(true);
            expect(LogViewToHostMessageSchema.safeParse({ type: 'undo' }).success).toBe(true);
            expect(LogViewToHostMessageSchema.safeParse({ type: 'redo' }).success).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'newChild',
                    payload: { changeId: 'kkmpptxz' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'newBefore',
                    payload: { changeIds: ['a', 'b'] },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'newAfter',
                    payload: { changeIds: ['c'] },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'edit',
                    payload: { changeId: 'kkmpptxz' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'squash',
                    payload: { changeId: 'kkmpptxz' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'abandon',
                    payload: { changeId: 'kkmpptxz' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'select',
                    payload: { changeId: 'kkmpptxz' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'getDetails',
                    payload: { changeId: 'kkmpptxz' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'resolve',
                    payload: { path: 'src/index.ts' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'moveBookmark',
                    payload: { bookmark: 'main', targetChangeId: 'kkmpptxz' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'rebaseCommit',
                    payload: { sourceChangeId: 'a', targetChangeId: 'b', mode: 'revision' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'rebaseCommit',
                    payload: { sourceChangeId: 'a', targetChangeId: 'b', mode: 'source' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'squashCommit',
                    payload: { sourceChangeId: 'a', targetChangeId: 'b', mode: 'into' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'squashCommit',
                    payload: { sourceChangeId: 'a', targetChangeId: 'b', mode: 'onto' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'duplicateCommit',
                    payload: { sourceChangeId: 'a' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'mergeCommit',
                    payload: { sourceChangeId: 'a', targetChangeId: 'b' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'upload',
                    payload: { changeId: 'kkmpptxz' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'showComments',
                    payload: { changeId: 'kkmpptxz' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'selectionChange',
                    payload: { commitIds: ['a', 'b'], hasImmutableSelection: false },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'setContextKey',
                    payload: { key: 'jj.testKey', value: true },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'openCodeForge',
                    payload: { url: 'https://github.com/foo/bar' },
                }).success,
            ).toBe(true);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'contextMenu',
                    payload: { changeId: 'x', selectedCommitIds: ['x', 'y'] },
                }).success,
            ).toBe(true);
        });

        it('rejects invalid LogViewToHostMessage payloads', () => {
            expect(LogViewToHostMessageSchema.safeParse({ type: 'unknownAction' }).success).toBe(false);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'rebaseCommit',
                    payload: { sourceChangeId: 'a', targetChangeId: 'b', mode: 'invalid_mode' },
                }).success,
            ).toBe(false);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'squashCommit',
                    payload: { sourceChangeId: 'a', targetChangeId: 'b', mode: 'invalid' },
                }).success,
            ).toBe(false);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'moveBookmark',
                    payload: { bookmark: 'main' }, // missing targetChangeId
                }).success,
            ).toBe(false);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'resolve',
                    payload: {}, // missing path
                }).success,
            ).toBe(false);
            expect(
                LogViewToHostMessageSchema.safeParse({
                    type: 'selectionChange',
                    payload: { commitIds: 'not-an-array' },
                }).success,
            ).toBe(false);
        });

        it('validates LogViewHostToWebviewMessage variants', () => {
            expect(
                LogViewHostToWebviewMessageSchema.safeParse({
                    type: 'update',
                    payload: {
                        commits: [],
                        minChangeIdLength: 3,
                        theme: 'default',
                        graphLabelAlignment: 'aligned',
                        hiddenActions: ['edit', 'abandon'],
                    },
                }).success,
            ).toBe(true);
            expect(
                LogViewHostToWebviewMessageSchema.safeParse({
                    type: 'updateHiddenActions',
                    payload: { hiddenActions: ['newChild'] },
                }).success,
            ).toBe(true);
            expect(
                LogViewHostToWebviewMessageSchema.safeParse({
                    type: 'panelClosed',
                    payload: { changeId: 'kkmpptxz' },
                }).success,
            ).toBe(true);
            expect(
                LogViewHostToWebviewMessageSchema.safeParse({
                    type: 'setSelection',
                    payload: { ids: ['kkmpptxz'] },
                }).success,
            ).toBe(true);

            expect(LogViewHostToWebviewMessageSchema.safeParse({ type: 'unknownHostType' }).success).toBe(false);
            expect(
                LogViewHostToWebviewMessageSchema.safeParse({
                    type: 'setSelection',
                    ids: 'not-an-array',
                }).success,
            ).toBe(false);
        });
    });

    describe('CommitDetails Schemas', () => {
        it('validates all CommitDetailsToHostMessage variants', () => {
            expect(CommitDetailsToHostMessageSchema.safeParse({ type: 'webviewLoaded' }).success).toBe(true);
            expect(
                CommitDetailsToHostMessageSchema.safeParse({
                    type: 'descriptionChanged',
                    payload: { description: 'Updated description', selectionStart: 0, selectionEnd: 5 },
                }).success,
            ).toBe(true);
            expect(
                CommitDetailsToHostMessageSchema.safeParse({
                    type: 'saveDescription',
                    payload: { changeId: 'kkmpptxz', description: 'New description' },
                }).success,
            ).toBe(true);
            expect(
                CommitDetailsToHostMessageSchema.safeParse({
                    type: 'openDiff',
                    payload: {
                        file: {
                            status: 'modified',
                            path: 'src/index.ts',
                            conflicted: false,
                        },
                        changeId: 'kkmpptxz',
                        isImmutable: false,
                    },
                }).success,
            ).toBe(true);
            expect(
                CommitDetailsToHostMessageSchema.safeParse({
                    type: 'openMultiDiff',
                    payload: { changeId: 'kkmpptxz' },
                }).success,
            ).toBe(true);
        });

        it('rejects invalid CommitDetailsToHostMessage payloads', () => {
            expect(CommitDetailsToHostMessageSchema.safeParse({ type: 'unknownDetailsAction' }).success).toBe(false);
            expect(
                CommitDetailsToHostMessageSchema.safeParse({
                    type: 'saveDescription',
                    payload: { changeId: 'kkmpptxz' }, // missing description
                }).success,
            ).toBe(false);
            expect(
                CommitDetailsToHostMessageSchema.safeParse({
                    type: 'openDiff',
                    payload: { changeId: 'kkmpptxz' }, // missing file
                }).success,
            ).toBe(false);
        });

        it('validates CommitDetailsHostToWebviewMessage variants', () => {
            expect(
                CommitDetailsHostToWebviewMessageSchema.safeParse({
                    type: 'update',
                    payload: {
                        changeId: 'kkmpptxz',
                        commitId: 'abcdef12',
                        description: 'Initial commit',
                    },
                }).success,
            ).toBe(true);
            expect(
                CommitDetailsHostToWebviewMessageSchema.safeParse({
                    type: 'saveComplete',
                    payload: { description: 'Saved description' },
                }).success,
            ).toBe(true);
            expect(
                CommitDetailsHostToWebviewMessageSchema.safeParse({
                    type: 'saveFailed',
                }).success,
            ).toBe(true);
            expect(
                CommitDetailsHostToWebviewMessageSchema.safeParse({
                    type: 'updateDescription',
                    payload: { description: 'Live updated', selectionStart: 2, selectionEnd: 2 },
                }).success,
            ).toBe(true);

            expect(CommitDetailsHostToWebviewMessageSchema.safeParse({ type: 'invalidType' }).success).toBe(false);
        });
    });

    describe('ProcessMonitor Schemas', () => {
        it('validates ProcessMonitorToHostMessage variants with command discriminator', () => {
            expect(
                ProcessMonitorToHostMessageSchema.safeParse({
                    command: 'killProcess',
                    payload: { id: 1234 },
                }).success,
            ).toBe(true);
            expect(
                ProcessMonitorToHostMessageSchema.safeParse({
                    command: 'killAllProcesses',
                }).success,
            ).toBe(true);
            expect(
                ProcessMonitorToHostMessageSchema.safeParse({
                    command: 'clearHistory',
                }).success,
            ).toBe(true);
            expect(
                ProcessMonitorToHostMessageSchema.safeParse({
                    command: 'hidePanel',
                }).success,
            ).toBe(true);

            expect(
                ProcessMonitorToHostMessageSchema.safeParse({
                    command: 'unknownCommand',
                }).success,
            ).toBe(false);
            expect(
                ProcessMonitorToHostMessageSchema.safeParse({
                    command: 'killProcess',
                    id: 'not-a-number',
                }).success,
            ).toBe(false);
        });

        it('validates ProcessMonitorHostToWebviewMessage variants', () => {
            expect(
                ProcessMonitorHostToWebviewMessageSchema.safeParse({
                    type: 'update',
                    payload: {
                        activeTasks: [
                            {
                                id: 1,
                                command: 'jj',
                                args: ['log'],
                                startPerformanceTime: 1000,
                                timestamp: Date.now(),
                                label: 'Log',
                                pid: 42,
                            },
                        ],
                        historyTasks: [
                            {
                                id: 2,
                                command: 'jj',
                                args: ['status'],
                                duration: 150,
                                status: 'completed',
                                label: 'Status',
                                error: '',
                                stdout: 'OK',
                                stderr: '',
                                exitCode: 0,
                                timestamp: Date.now(),
                            },
                        ],
                        metrics: {
                            activeCount: 1,
                            peakConcurrency: 2,
                            totalCount: 5,
                            avgDurationMs: 120,
                        },
                    },
                }).success,
            ).toBe(true);

            // Rejects invalid task status
            expect(
                ProcessMonitorHostToWebviewMessageSchema.safeParse({
                    type: 'update',
                    activeTasks: [],
                    historyTasks: [
                        {
                            id: 2,
                            command: 'jj',
                            args: [],
                            duration: 150,
                            status: 'invalid_status_enum',
                            label: 'Status',
                            error: '',
                            stdout: '',
                            stderr: '',
                            exitCode: 0,
                            timestamp: Date.now(),
                        },
                    ],
                    metrics: {
                        activeCount: 0,
                        peakConcurrency: 0,
                        totalCount: 0,
                        avgDurationMs: 0,
                    },
                }).success,
            ).toBe(false);
        });
    });
});
