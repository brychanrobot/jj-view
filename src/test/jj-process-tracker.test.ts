/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';
import { getTaskExitCode, isProcessTerminated, type JjProcessTask, JjProcessTracker } from '../core/jj-process-tracker';
import { createMock } from './test-utils';

describe('JjProcessTracker Unit Tests', () => {
    test('tracks process start and finish lifecycle', () => {
        const tracker = new JjProcessTracker();
        const listener = vi.fn();
        tracker.onDidChangeProcesses(listener);

        const handle = tracker.startTrackingProcess({
            command: 'jj log',
            args: ['log'],
            status: 'running',
            label: 'test',
            childProcess: createMock<ChildProcess>({ pid: 1234 }),
        });

        expect(tracker.getActiveTasks()).toHaveLength(1);
        expect(tracker.getActiveTasks()[0].id).toBe(handle.id);
        expect(tracker.getMetrics().activeCount).toBe(1);
        expect(tracker.getMetrics().peakConcurrency).toBe(1);
        expect(listener).toHaveBeenCalledTimes(1);

        tracker.onFinishProcess(handle.id, 'completed');

        expect(tracker.getActiveTasks()).toHaveLength(0);
        expect(tracker.getHistory()).toHaveLength(1);
        expect(tracker.getHistory()[0].status).toBe('completed');
        expect(tracker.getMetrics().activeCount).toBe(0);
        expect(tracker.getMetrics().totalCount).toBe(1);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    test('finishes process via returned IJjTrackedProcess handle', () => {
        const tracker = new JjProcessTracker();
        const trackedProcess = tracker.startTrackingProcess({
            command: 'jj log',
            args: ['log'],
            status: 'running',
            childProcess: createMock<ChildProcess>({}),
        });

        expect(trackedProcess.id).toBeDefined();
        expect(tracker.getActiveTasks()).toHaveLength(1);

        trackedProcess.finish('completed', undefined, 'stdout content', '', 0);

        expect(tracker.getActiveTasks()).toHaveLength(0);
        expect(tracker.getHistory()).toHaveLength(1);
        expect(tracker.getHistory()[0].stdout).toBe('stdout content');
    });

    test('stores stdout, stderr, and exit code on process finish', () => {
        const tracker = new JjProcessTracker();
        const handle = tracker.startTrackingProcess({
            command: 'jj status',
            args: ['status'],
            status: 'running',
            childProcess: createMock<ChildProcess>({ exitCode: null }),
        });

        tracker.onFinishProcess(handle.id, 'completed', undefined, 'Working copy changes:', '', 0);

        const history = tracker.getHistory();
        expect(history[0].stdout).toBe('Working copy changes:');
        expect(getTaskExitCode(history[0])).toBe(0);
    });

    test('cancels active process using childProcess.kill()', () => {
        const tracker = new JjProcessTracker();
        const killFn = vi.fn();
        const mockChildProcess = createMock<ChildProcess>({ kill: killFn });

        const handle = tracker.startTrackingProcess({
            command: 'jj status',
            args: ['status'],
            status: 'running',
            childProcess: mockChildProcess,
        });

        const cancelled = tracker.cancelProcess(handle.id);
        expect(cancelled).toBe(true);
        expect(killFn).toHaveBeenCalled();
        expect(tracker.getActiveTasks()).toHaveLength(0);
        expect(tracker.getHistory()[0].status).toBe('cancelled');
    });

    test('cancelAllProcesses terminates all active processes', () => {
        const tracker = new JjProcessTracker();
        const killFn1 = vi.fn();
        const killFn2 = vi.fn();

        tracker.startTrackingProcess({
            command: 'jj op log',
            args: ['op', 'log'],
            status: 'running',
            childProcess: createMock<ChildProcess>({ kill: killFn1 }),
        });

        tracker.startTrackingProcess({
            command: 'jj status',
            args: ['status'],
            status: 'running',
            childProcess: createMock<ChildProcess>({ kill: killFn2 }),
        });

        expect(tracker.getMetrics().activeCount).toBe(2);
        expect(tracker.getMetrics().peakConcurrency).toBe(2);

        tracker.cancelAllProcesses();

        expect(killFn1).toHaveBeenCalled();
        expect(killFn2).toHaveBeenCalled();
        expect(tracker.getActiveTasks()).toHaveLength(0);
        expect(tracker.getHistory()).toHaveLength(2);
    });

    test('clears history and caps history size to 50', () => {
        const tracker = new JjProcessTracker();

        for (let i = 1; i <= 60; i++) {
            const handle = tracker.startTrackingProcess({
                command: `jj cmd ${i}`,
                args: ['cmd', String(i)],
                status: 'running',
                childProcess: createMock<ChildProcess>({}),
            });
            tracker.onFinishProcess(handle.id, 'completed');
        }

        expect(tracker.getHistory()).toHaveLength(50);
        expect(tracker.getHistory()[0].id).toBe(60); // Most recent
        expect(tracker.getMetrics().totalCount).toBe(60);

        tracker.clearHistory();
        expect(tracker.getHistory()).toHaveLength(0);
    });

    test('extracts pid automatically from childProcess and formats Error object with exitCode', () => {
        const tracker = new JjProcessTracker();
        const mockChildProcess = createMock<ChildProcess>({ pid: 9876, exitCode: null, killed: false });

        const handle = tracker.startTrackingProcess({
            command: 'jj diff',
            args: ['diff'],
            status: 'running',
            childProcess: mockChildProcess,
        });

        expect(tracker.getActiveTasks()[0].childProcess.pid).toBe(9876);

        const customErr = Object.assign(new Error('Command failed: jj diff'), { code: 127 });

        handle.finish('failed', customErr, 'stdout sample text', 'stderr sample text');

        const history = tracker.getHistory();
        expect(history).toHaveLength(1);
        expect(history[0].status).toBe('failed');
        expect(getTaskExitCode(history[0])).toBe(1);
        expect(history[0].error).toContain('stdout sample text');
        expect(history[0].error).toContain('stderr sample text');
    });

    test('derives cancelled status automatically when childProcess was killed', () => {
        const tracker = new JjProcessTracker();
        const mockChildProcess = createMock<ChildProcess>({ pid: 5432, killed: true });

        const handle = tracker.startTrackingProcess({
            command: 'jj status',
            args: ['status'],
            status: 'running',
            childProcess: mockChildProcess,
        });

        handle.finish('failed', 'Process killed');

        const history = tracker.getHistory();
        expect(history[0].status).toBe('cancelled');
    });

    test('does not populate error field on completed successful tasks with stdout', () => {
        const tracker = new JjProcessTracker();
        const handle = tracker.startTrackingProcess({
            command: 'jj log',
            args: ['log'],
            status: 'running',
            childProcess: createMock<ChildProcess>({ exitCode: null }),
        });

        handle.finish('completed', undefined, 'Working copy changes:\nM file.txt', '', 0);

        const history = tracker.getHistory();
        expect(history[0].status).toBe('completed');
        expect(getTaskExitCode(history[0])).toBe(0);
        expect(history[0].error).toBeUndefined();
        expect(history[0].stdout).toBe('Working copy changes:\nM file.txt');
    });

    test('cancelAllProcesses fires change event exactly once for multiple processes', () => {
        const tracker = new JjProcessTracker();
        const listener = vi.fn();
        tracker.onDidChangeProcesses(listener);

        for (let i = 1; i <= 5; i++) {
            tracker.startTrackingProcess({
                command: `jj cmd ${i}`,
                args: ['cmd', String(i)],
                status: 'running',
                childProcess: createMock<ChildProcess>({ kill: vi.fn() }),
            });
        }

        listener.mockClear();
        tracker.cancelAllProcesses();

        expect(listener).toHaveBeenCalledTimes(1);
        expect(tracker.getActiveTasks()).toHaveLength(0);
        expect(tracker.getHistory()).toHaveLength(5);
    });

    test('immediately finishes pre-terminated processes when startTrackingProcess is called', () => {
        const tracker = new JjProcessTracker();
        const mockFinishedChild = createMock<ChildProcess>({
            pid: 4321,
            exitCode: 0,
            signalCode: null,
            killed: false,
        });

        const handle = tracker.startTrackingProcess({
            command: 'jj status',
            args: ['status'],
            status: 'running',
            childProcess: mockFinishedChild,
        });

        expect(handle.id).toBeDefined();
        expect(tracker.getActiveTasks()).toHaveLength(0);
        expect(tracker.getHistory()).toHaveLength(1);
        expect(tracker.getHistory()[0].status).toBe('completed');
        expect(tracker.getHistory()[0].childProcess.exitCode).toBe(0);
    });

    test('immediately finishes process with signalCode set when startTrackingProcess is called', () => {
        const tracker = new JjProcessTracker();
        const mockTerminatedChild = createMock<ChildProcess>({
            pid: 5555,
            exitCode: null,
            signalCode: 'SIGTERM',
            killed: false,
        });

        const handle = tracker.startTrackingProcess({
            command: 'jj status',
            args: ['status'],
            status: 'running',
            childProcess: mockTerminatedChild,
        });

        expect(handle.id).toBeDefined();
        expect(tracker.getActiveTasks()).toHaveLength(0);
        expect(tracker.getHistory()).toHaveLength(1);
        expect(tracker.getHistory()[0].status).toBe('completed');
    });

    test('keeps process in active tasks when exitCode is null and killed is false', () => {
        const tracker = new JjProcessTracker();
        const mockActiveChild = createMock<ChildProcess>({
            pid: 8888,
            exitCode: null,
            signalCode: null,
            killed: false,
        });

        const handle = tracker.startTrackingProcess({
            command: 'jj status',
            args: ['status'],
            status: 'running',
            childProcess: mockActiveChild,
        });

        expect(handle.id).toBeDefined();
        expect(tracker.getActiveTasks()).toHaveLength(1);
        expect(tracker.getHistory()).toHaveLength(0);
    });

    test('updates existing history entry with stdout/stderr when onFinishProcess is called after initial finish', () => {
        const tracker = new JjProcessTracker();
        const mockFinishedChild = createMock<ChildProcess>({
            pid: 7777,
            exitCode: 1,
            signalCode: null,
            killed: false,
        });

        const handle = tracker.startTrackingProcess({
            command: 'jj status',
            args: ['status'],
            status: 'running',
            childProcess: mockFinishedChild,
        });

        expect(tracker.getHistory()).toHaveLength(1);
        expect(tracker.getHistory()[0].stdout).toBeUndefined();

        handle.finish('failed', new Error('Command failed: jj status'), 'stdout text', 'stderr text');

        const history = tracker.getHistory();
        expect(history).toHaveLength(1);
        expect(history[0].status).toBe('failed');
        expect(history[0].stdout).toBe('stdout text');
        expect(history[0].stderr).toBe('stderr text');
        expect(history[0].error).toContain('stderr text');
    });

    test('dispose cleans up event emitter and prevents future notifications', () => {
        const tracker = new JjProcessTracker();
        const listener = vi.fn();
        tracker.onDidChangeProcesses(listener);

        tracker.dispose();

        tracker.startTrackingProcess({
            command: 'jj log',
            args: ['log'],
            status: 'running',
            childProcess: createMock<ChildProcess>({}),
        });

        expect(listener).not.toHaveBeenCalled();
    });
});

describe('isProcessTerminated Unit Tests', () => {
    test('returns true when exitCode is a number', () => {
        const cp = createMock<ChildProcess>({ exitCode: 0, signalCode: null, killed: false });
        expect(isProcessTerminated(cp)).toBe(true);

        const cpErr = createMock<ChildProcess>({ exitCode: 1, signalCode: null, killed: false });
        expect(isProcessTerminated(cpErr)).toBe(true);
    });

    test('returns true when signalCode is a string', () => {
        const cp = createMock<ChildProcess>({ exitCode: null, signalCode: 'SIGKILL', killed: false });
        expect(isProcessTerminated(cp)).toBe(true);
    });

    test('returns true when killed is true', () => {
        const cp = createMock<ChildProcess>({ exitCode: null, signalCode: null, killed: true });
        expect(isProcessTerminated(cp)).toBe(true);
    });

    test('returns false when process is running', () => {
        const cp = createMock<ChildProcess>({ exitCode: null, signalCode: null, killed: false });
        expect(isProcessTerminated(cp)).toBe(false);
    });

    test('returns false when properties are undefined (e.g. test mocks)', () => {
        const cp = createMock<ChildProcess>({});
        expect(isProcessTerminated(cp)).toBe(false);
    });
});

describe('getTaskExitCode Unit Tests', () => {
    test('returns exitCode when set on childProcess', () => {
        const task = createMock<JjProcessTask>({
            childProcess: createMock<ChildProcess>({ exitCode: 0 }),
            status: 'completed',
        });
        expect(getTaskExitCode(task)).toBe(0);

        const taskErr = createMock<JjProcessTask>({
            childProcess: createMock<ChildProcess>({ exitCode: 127 }),
            status: 'failed',
        });
        expect(getTaskExitCode(taskErr)).toBe(127);
    });

    test('falls back to 0 for completed tasks when exitCode is null', () => {
        const task = createMock<JjProcessTask>({
            childProcess: createMock<ChildProcess>({ exitCode: null }),
            status: 'completed',
        });
        expect(getTaskExitCode(task)).toBe(0);
    });

    test('falls back to 1 for non-completed tasks when exitCode is null', () => {
        const task = createMock<JjProcessTask>({
            childProcess: createMock<ChildProcess>({ exitCode: null }),
            status: 'failed',
        });
        expect(getTaskExitCode(task)).toBe(1);

        const cancelledTask = createMock<JjProcessTask>({
            childProcess: createMock<ChildProcess>({ exitCode: null }),
            status: 'cancelled',
        });
        expect(getTaskExitCode(cancelledTask)).toBe(1);
    });
});
