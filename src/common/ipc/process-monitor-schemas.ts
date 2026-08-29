/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';

export const ProcessMonitorToHostMessageSchema = z.discriminatedUnion('command', [
    z.object({
        command: z.literal('killProcess'),
        payload: z.object({ id: z.number() }),
    }),
    z.object({ command: z.literal('killAllProcesses') }),
    z.object({ command: z.literal('clearHistory') }),
    z.object({ command: z.literal('hidePanel') }),
]);
export type ProcessMonitorToHostMessage = z.infer<typeof ProcessMonitorToHostMessageSchema>;

export const ProcessMonitorActiveTaskSchema = z.object({
    id: z.number(),
    command: z.string(),
    args: z.array(z.string()),
    startPerformanceTime: z.number(),
    timestamp: z.number(),
    label: z.string(),
    pid: z.number(),
});
export type ProcessMonitorActiveTask = z.infer<typeof ProcessMonitorActiveTaskSchema>;

export const ProcessMonitorHistoryTaskSchema = z.object({
    id: z.number(),
    command: z.string(),
    args: z.array(z.string()),
    duration: z.number(),
    status: z.enum(['running', 'completed', 'failed', 'timed_out', 'cancelled']),
    label: z.string(),
    error: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    timestamp: z.number(),
});
export type ProcessMonitorHistoryTask = z.infer<typeof ProcessMonitorHistoryTaskSchema>;

export const ProcessMonitorMetricsSchema = z.object({
    activeCount: z.number(),
    peakConcurrency: z.number(),
    totalCount: z.number(),
    avgDurationMs: z.number(),
});
export type ProcessMonitorMetrics = z.infer<typeof ProcessMonitorMetricsSchema>;

export const ProcessMonitorPayloadSchema = z.object({
    activeTasks: z.array(ProcessMonitorActiveTaskSchema),
    historyTasks: z.array(ProcessMonitorHistoryTaskSchema),
    metrics: ProcessMonitorMetricsSchema,
});
export type ProcessMonitorPayload = z.infer<typeof ProcessMonitorPayloadSchema>;

export const ProcessMonitorHostToWebviewMessageSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('update'),
        payload: ProcessMonitorPayloadSchema,
    }),
]);
export type ProcessMonitorHostToWebviewMessage = z.infer<typeof ProcessMonitorHostToWebviewMessageSchema>;
