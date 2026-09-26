/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NotificationService } from '../src/notifications/notification-service';

describe('NotificationService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('should initialize with default position and empty items', () => {
        const service = new NotificationService();
        expect(service.position).toBe('bottom-right');
        expect(service.items).toEqual([]);
    });

    test('should allow configuring position and fire listener', () => {
        const service = new NotificationService({ position: 'top-right' });
        expect(service.position).toBe('top-right');

        const positions: string[] = [];
        const sub = service.onDidChangePosition((pos) => positions.push(pos));

        service.setPosition('bottom-left');
        expect(service.position).toBe('bottom-left');
        expect(positions).toEqual(['bottom-left']);

        sub.dispose();
        service.setPosition('top-left');
        expect(positions).toEqual(['bottom-left']);
    });

    test('should create information notification and auto-dismiss after timeout', async () => {
        const service = new NotificationService({ defaultInfoTimeoutMs: 3000 });
        let resolvedValue: string | undefined = 'initial';

        const promise = service.showInformation('Test info message').then((res) => {
            resolvedValue = res;
        });

        expect(service.items).toHaveLength(1);
        expect(service.items[0].severity).toBe('info');
        expect(service.items[0].message).toBe('Test info message');
        expect(service.items[0].actions).toEqual([]);

        // Advance timers past timeout
        vi.advanceTimersByTime(3000);
        await promise;

        expect(resolvedValue).toBeUndefined();
        expect(service.items).toHaveLength(0);
    });

    test('should not auto-dismiss notification if actions are present', async () => {
        const service = new NotificationService({ defaultInfoTimeoutMs: 3000 });
        let isResolved = false;

        void service.showInformation('Save changes?', 'Save', 'Discard').then(() => {
            isResolved = true;
        });

        expect(service.items).toHaveLength(1);
        expect(service.items[0].actions).toEqual(['Save', 'Discard']);

        vi.advanceTimersByTime(5000);
        expect(isResolved).toBe(false);
        expect(service.items).toHaveLength(1);
    });

    test('should resolve selected action when action is triggered', async () => {
        const service = new NotificationService();
        let selectedAction: string | undefined;

        void service.showWarning('Confirm deletion', 'Yes', 'No').then((action) => {
            selectedAction = action;
        });

        const item = service.items[0];
        expect(item).toBeDefined();

        service.triggerAction(item.id, 'Yes');
        await vi.runAllTimersAsync();

        expect(selectedAction).toBe('Yes');
        expect(service.items).toHaveLength(0);
    });

    test('should resolve undefined when dismissed manually', async () => {
        const service = new NotificationService();
        let resolvedAction: string | undefined = 'not-called';

        void service.showErrorMessage('Fatal error occurred', 'Retry').then((action) => {
            resolvedAction = action;
        });

        const item = service.items[0];
        service.dismiss(item.id);
        await vi.runAllTimersAsync();

        expect(resolvedAction).toBeUndefined();
        expect(service.items).toHaveLength(0);
    });

    test('should clear all notifications', async () => {
        const service = new NotificationService();
        void service.showInformation('Info 1');
        void service.showWarning('Warning 2');
        void service.showErrorMessage('Error 3');

        expect(service.items).toHaveLength(3);

        service.clearAll();
        await vi.runAllTimersAsync();

        expect(service.items).toHaveLength(0);
    });
});
