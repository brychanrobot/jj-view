/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ProcessMonitorController } from '../core/controllers/process-monitor-controller';
import { JjProcessTracker } from '../core/jj-process-tracker';
import { FakeHostEnvironment } from './fake-host-environment';
import { createMock } from './test-utils';

describe('ProcessMonitorController Domain Unit Tests', () => {
    let tracker: JjProcessTracker;
    let fakeHost: FakeHostEnvironment;
    let controller: ProcessMonitorController;
    let postedMessages: unknown[];

    beforeEach(() => {
        tracker = new JjProcessTracker();
        fakeHost = new FakeHostEnvironment();
        postedMessages = [];

        controller = new ProcessMonitorController(tracker, fakeHost, {
            messenger: {
                postMessage: (m) => postedMessages.push(m),
            },
        });
    });

    afterEach(() => {
        controller.dispose();
    });

    test('retrieves active and history tasks and updates webview', () => {
        const cp = createMock<ChildProcess>({ pid: 1234, exitCode: null, signalCode: null, killed: false });
        const trackedProcess = tracker.startTrackingProcess({
            command: 'jj status',
            args: ['status'],
            childProcess: cp,
            status: 'running',
        });

        controller.updateWebview();

        expect(controller.activeTasks.length).toBe(1);
        expect(controller.activeTasks[0].command).toBe('jj status');

        trackedProcess.finish('completed');
        controller.updateWebview();

        expect(controller.activeTasks.length).toBe(0);
        expect(controller.historyTasks.length).toBe(1);
        expect(controller.historyTasks[0].status).toBe('completed');
    });

    test('handles RPC messages via handleMessage', async () => {
        const cancelSpy = vi.spyOn(tracker, 'cancelProcess');
        const clearSpy = vi.spyOn(tracker, 'clearHistory');
        const updateConfigSpy = vi.spyOn(fakeHost.config, 'update');

        const killHandled = await controller.handleMessage({ command: 'killProcess', payload: { id: 42 } });
        expect(killHandled).toBe(true);
        expect(cancelSpy).toHaveBeenCalledWith(42);

        const clearHandled = await controller.handleMessage({ command: 'clearHistory' });
        expect(clearHandled).toBe(true);
        expect(clearSpy).toHaveBeenCalled();

        const hideHandled = await controller.handleMessage({ command: 'hidePanel' });
        expect(hideHandled).toBe(true);
        expect(updateConfigSpy).toHaveBeenCalledWith('showProcessMonitorPanel', false);
    });

    test('cancels all processes and clears history', () => {
        const cancelAllSpy = vi.spyOn(tracker, 'cancelAllProcesses');
        controller.cancelAllProcesses();
        expect(cancelAllSpy).toHaveBeenCalled();
    });

    test('replays initial snapshot on setMessenger and responds to webviewLoaded', async () => {
        const newMessages: unknown[] = [];
        controller.setMessenger({
            postMessage: (m) => newMessages.push(m),
        });

        expect(newMessages).toHaveLength(1);
        expect(newMessages[0]).toEqual(
            expect.objectContaining({
                type: 'update',
                payload: expect.objectContaining({
                    activeTasks: expect.any(Array),
                    historyTasks: expect.any(Array),
                    metrics: expect.any(Object),
                }),
            }),
        );

        const loadedHandled = await controller.handleMessage({ command: 'webviewLoaded' });
        expect(loadedHandled).toBe(true);
        expect(newMessages).toHaveLength(2);
    });
});
