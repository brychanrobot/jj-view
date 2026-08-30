/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import { type Disposable, type Event, EventEmitter } from './host/events';

export type JjProcessStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

export interface JjProcessTask {
    id: number;
    command: string;
    args: string[];
    childProcess: ChildProcess;
    startPerformanceTime: number;
    duration?: number;
    status: JjProcessStatus;
    label?: string;
    error?: string;
    stdout?: string;
    stderr?: string;
    timestamp?: number;
}

export interface IJjTrackedProcess {
    readonly id: number;
    finish(
        status?: Exclude<JjProcessStatus, 'running'>,
        error?: Error | string,
        stdout?: string | Buffer,
        stderr?: string | Buffer,
        _exitCode?: number,
    ): void;
}

export interface JjProcessMetrics {
    activeCount: number;
    peakConcurrency: number;
    totalCount: number;
    avgDurationMs: number;
}

export class JjProcessTracker implements Disposable {
    private readonly _activeTasks = new Map<number, JjProcessTask>();
    private readonly _history: JjProcessTask[] = [];
    private readonly _maxHistorySize = 50;
    private _peakConcurrency = 0;
    private _totalCompletedCount = 0;
    private _totalCompletedDurationMs = 0;

    private readonly _onDidChangeProcesses = new EventEmitter<void>();
    public readonly onDidChangeProcesses: Event<void> = this._onDidChangeProcesses.event;

    private _nextId = 1;

    public startTrackingProcess(
        task: Omit<JjProcessTask, 'id' | 'startPerformanceTime' | 'timestamp'>,
    ): IJjTrackedProcess {
        const id = this._nextId++;
        const timestamp = Date.now();
        const startPerformanceTime = performance.now();
        const fullTask: JjProcessTask = { ...task, id, timestamp, startPerformanceTime };
        this._activeTasks.set(id, fullTask);
        if (this._activeTasks.size > this._peakConcurrency) {
            this._peakConcurrency = this._activeTasks.size;
        }
        this._onDidChangeProcesses.fire();

        const trackedProcess: IJjTrackedProcess = {
            id,
            finish: (
                status?: Exclude<JjProcessStatus, 'running'>,
                error?: Error | string,
                stdout?: string | Buffer,
                stderr?: string | Buffer,
                _exitCode?: number,
            ) => {
                this.onFinishProcess(id, status, error, stdout, stderr, _exitCode);
            },
        };

        const cp = task.childProcess;
        if (isProcessTerminated(cp)) {
            trackedProcess.finish();
        }

        return trackedProcess;
    }

    public onFinishProcess(
        opId: number,
        status?: Exclude<JjProcessStatus, 'running'>,
        error?: Error | string,
        stdout?: string | Buffer,
        stderr?: string | Buffer,
        _exitCode?: number,
        fireEvent = true,
    ): void {
        const task = this._activeTasks.get(opId);
        if (!task) {
            const historyIndex = this._history.findIndex((t) => t.id === opId);
            if (historyIndex !== -1) {
                const historyTask = this._history[historyIndex];
                const isCancelled = historyTask.childProcess.killed;
                const rawStdout = stdout?.toString() ?? historyTask.stdout;
                const rawStderr = stderr?.toString() ?? historyTask.stderr;
                const finalStatus = resolveProcessStatus(
                    status,
                    isCancelled,
                    !!error || historyTask.status === 'failed',
                );
                const errMessage =
                    formatProcessErrorMessage(error, finalStatus, rawStdout, rawStderr) ?? historyTask.error;

                this._history[historyIndex] = {
                    ...historyTask,
                    status: finalStatus,
                    error: errMessage,
                    stdout: truncateOutput(rawStdout),
                    stderr: truncateOutput(rawStderr),
                };

                if (fireEvent) {
                    this._onDidChangeProcesses.fire();
                }
            }
            return;
        }

        this._activeTasks.delete(opId);
        const duration = task.duration ?? Math.max(0, Math.round(performance.now() - task.startPerformanceTime));
        const timestamp = Date.now();

        const isCancelled = task.childProcess.killed;
        const rawStdout = stdout?.toString();
        const rawStderr = stderr?.toString();
        const finalStatus = resolveProcessStatus(status, isCancelled, !!error);
        const errMessage = formatProcessErrorMessage(error, finalStatus, rawStdout, rawStderr);

        const finishedTask: JjProcessTask = {
            ...task,
            duration,
            status: finalStatus,
            error: errMessage,
            timestamp,
            stdout: truncateOutput(rawStdout),
            stderr: truncateOutput(rawStderr),
        };

        this._history.unshift(finishedTask);
        if (this._history.length > this._maxHistorySize) {
            this._history.pop();
        }

        this._totalCompletedCount++;
        this._totalCompletedDurationMs += duration;

        if (fireEvent) {
            this._onDidChangeProcesses.fire();
        }
    }

    public cancelProcess(opId: number): boolean {
        const task = this._activeTasks.get(opId);
        if (!task) {
            return false;
        }

        if (task.childProcess) {
            try {
                task.childProcess.kill();
            } catch {}
        }

        this.onFinishProcess(opId, 'cancelled', 'Cancelled by user');
        return true;
    }

    public cancelAllProcesses(): void {
        const tasks = Array.from(this._activeTasks.values());
        for (const task of tasks) {
            if (task.childProcess) {
                try {
                    task.childProcess.kill();
                } catch {}
            }
            this.onFinishProcess(task.id, 'cancelled', 'Cancelled by user', undefined, undefined, undefined, false);
        }
        this._onDidChangeProcesses.fire();
    }

    public clearHistory(): void {
        this._history.length = 0;
        this._onDidChangeProcesses.fire();
    }

    public getActiveTasks(): JjProcessTask[] {
        return Array.from(this._activeTasks.values());
    }

    public getHistory(): JjProcessTask[] {
        return [...this._history];
    }

    public getMetrics(): JjProcessMetrics {
        const activeCount = this._activeTasks.size;
        const avgDurationMs =
            this._totalCompletedCount > 0 ? Math.round(this._totalCompletedDurationMs / this._totalCompletedCount) : 0;

        return {
            activeCount,
            peakConcurrency: this._peakConcurrency,
            totalCount: this._totalCompletedCount,
            avgDurationMs,
        };
    }

    public dispose(): void {
        this._onDidChangeProcesses.dispose();
    }
}

function resolveProcessStatus(
    status?: Exclude<JjProcessStatus, 'running'>,
    isCancelled?: boolean,
    hasError?: boolean,
): Exclude<JjProcessStatus, 'running'> {
    if (status === 'timed_out') {
        return 'timed_out';
    }
    if (isCancelled) {
        return 'cancelled';
    }
    if (status) {
        return status;
    }
    if (hasError) {
        return 'failed';
    }
    return 'completed';
}

export function isProcessTerminated(cp: ChildProcess): boolean {
    return typeof cp.exitCode === 'number' || typeof cp.signalCode === 'string' || cp.killed === true;
}

export function getTaskExitCode(task: JjProcessTask): number {
    if (typeof task.childProcess.exitCode === 'number') {
        return task.childProcess.exitCode;
    }
    return task.status === 'completed' ? 0 : 1;
}

function truncateOutput(text?: string, maxLen = 100_000): string | undefined {
    if (!text) {
        return undefined;
    }
    return text.length > maxLen ? `${text.substring(0, maxLen)}\n... [truncated]` : text;
}

function formatProcessErrorMessage(
    error: Error | string | undefined,
    finalStatus: JjProcessStatus,
    rawStdout?: string,
    rawStderr?: string,
): string | undefined {
    let errMessage = error instanceof Error ? error.message : error;
    if (finalStatus !== 'completed' && (!errMessage || errMessage.startsWith('Command failed'))) {
        const combined: string[] = [];
        const trimmedStdout = rawStdout?.trim();
        const trimmedStderr = rawStderr?.trim();
        if (trimmedStdout) {
            combined.push(trimmedStdout);
        }
        if (trimmedStderr) {
            combined.push(trimmedStderr);
        }
        if (combined.length > 0) {
            errMessage = combined.join('\n\n');
        }
    }
    return errMessage;
}
