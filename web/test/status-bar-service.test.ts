/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { StatusBarService } from '../src/status/status-bar-service';

describe('StatusBarService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('should initialize with idle state', () => {
        const service = new StatusBarService();
        expect(service.state).toEqual({
            statusMessage: undefined,
            progress: { active: false, title: undefined, activeTasks: 0 },
            workingCopy: undefined,
            connection: 'connected',
        });
    });

    test('should set and clear status message via disposable', () => {
        const service = new StatusBarService();
        const sub = service.setMessage('Absorb completed.');

        expect(service.state.statusMessage?.text).toBe('Absorb completed.');

        sub.dispose();
        expect(service.state.statusMessage).toBeUndefined();
    });

    test('should auto-clear status message after timeout', () => {
        const service = new StatusBarService();
        service.setMessage('Syncing...', 2000);

        expect(service.state.statusMessage?.text).toBe('Syncing...');

        vi.advanceTimersByTime(1999);
        expect(service.state.statusMessage?.text).toBe('Syncing...');

        vi.advanceTimersByTime(1);
        expect(service.state.statusMessage).toBeUndefined();
    });

    test('should track progress during withProgress task', async () => {
        const service = new StatusBarService();

        let progressInsideTask: unknown;
        const taskPromise = service.withProgress('Squashing revision...', async () => {
            progressInsideTask = service.state.progress;
            return 'done';
        });

        expect(service.state.progress.active).toBe(true);
        expect(service.state.progress.title).toBe('Squashing revision...');

        const result = await taskPromise;
        expect(result).toBe('done');
        expect(progressInsideTask).toEqual({
            active: true,
            title: 'Squashing revision...',
            activeTasks: 1,
        });

        expect(service.state.progress.active).toBe(false);
        expect(service.state.progress.title).toBeUndefined();
    });

    test('should handle concurrent progress tasks correctly', async () => {
        const service = new StatusBarService();

        let resolveTask1: () => void = () => {};
        let resolveTask2: () => void = () => {};

        const p1 = service.withProgress('Task 1', () => new Promise<void>((r) => (resolveTask1 = r)));
        const p2 = service.withProgress('Task 2', () => new Promise<void>((r) => (resolveTask2 = r)));

        expect(service.state.progress.activeTasks).toBe(2);
        expect(service.state.progress.title).toBe('Task 2');

        resolveTask2();
        await p2;

        expect(service.state.progress.activeTasks).toBe(1);
        expect(service.state.progress.title).toBe('Task 2');

        resolveTask1();
        await p1;

        expect(service.state.progress.activeTasks).toBe(0);
        expect(service.state.progress.active).toBe(false);
        expect(service.state.progress.title).toBeUndefined();
    });

    test('should update working copy and connection status', () => {
        const service = new StatusBarService();

        service.setWorkingCopy({ changeId: 'qpvuntsm', bookmark: 'main' });
        expect(service.state.workingCopy).toEqual({ changeId: 'qpvuntsm', bookmark: 'main' });

        service.setConnectionStatus('disconnected');
        expect(service.state.connection).toBe('disconnected');
    });
});
