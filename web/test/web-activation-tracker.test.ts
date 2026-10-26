/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import '../../src/test/vitest-utils';
import { WebActivationTracker } from '../src/host/web-activation-tracker';
import type { SidecarBridge } from '../src/sidecar/sidecar-types';
import { createMock } from './test-mock';

describe('WebActivationTracker', () => {
    it('stays active when blurred in embedded iframe mode and pulses on pointerenter, focus, visibilitychange, and postMessage', () => {
        const handlers = new Map<string, (ev?: unknown) => void>();
        const addWindowListener = vi.fn((event: string, handler: EventListenerOrEventListenerObject) => {
            if (typeof handler === 'function') {
                handlers.set(`window:${event}`, handler as (ev?: unknown) => void);
            }
        });
        const addDocListener = vi.fn((event: string, handler: EventListenerOrEventListenerObject) => {
            if (typeof handler === 'function') {
                handlers.set(`doc:${event}`, handler as (ev?: unknown) => void);
            }
        });

        const originalWindow = globalThis.window;
        const originalDoc = globalThis.document;

        let isHidden = false;
        let hasFocus = false; // In an iframe, keyboard focus starts in the parent window

        try {
            const parentWin = createMock<Window>({});
            globalThis.window = createMock<Window & typeof globalThis>({
                parent: parentWin,
                sidecar: createMock<SidecarBridge>({}),
                addEventListener: addWindowListener,
                removeEventListener: vi.fn(),
            });
            globalThis.document = createMock<Document>({
                get hidden() {
                    return isHidden;
                },
                hasFocus: () => hasFocus,
                addEventListener: addDocListener,
                removeEventListener: vi.fn(),
            });

            const tracker = new WebActivationTracker();
            // Even with hasFocus = false, embedded iframe starts active because !document.hidden
            expect(tracker.isActive).toBe(true);

            const events: boolean[] = [];
            tracker.onDidChangeActive((active) => events.push(active));

            // 1. Blurring the iframe (e.g. clicking into the parent chat pane) keeps isActive = true
            handlers.get('window:blur')?.();
            expect(tracker.isActive).toBe(true);
            expect(events).toEqual([]);

            // 2. Pointer entering the iframe pulses onDidChangeActive(true) even though isActive is already true
            handlers.get('doc:pointerenter')?.();
            expect(tracker.isActive).toBe(true);
            expect(events).toEqual([true]);

            // 3. Focusing the iframe pulses onDidChangeActive(true)
            hasFocus = true;
            handlers.get('window:focus')?.();
            expect(events).toEqual([true, true]);

            // 4. Hiding the tab marks tracker inactive; showing it again pulses true even if hasFocus is false
            hasFocus = false;
            isHidden = true;
            handlers.get('doc:visibilitychange')?.();
            expect(tracker.isActive).toBe(false);
            expect(events).toEqual([true, true, false]);

            isHidden = false;
            handlers.get('doc:visibilitychange')?.();
            expect(tracker.isActive).toBe(true);
            expect(events).toEqual([true, true, false, true]);

            // 5. Parent postMessage({ type: 'window-focus', payload: { focused: true } }) pulses true
            handlers.get('window:message')?.({
                data: { type: 'window-focus', payload: { focused: true } },
            });
            expect(events).toEqual([true, true, false, true, true]);

            tracker.dispose();
        } finally {
            globalThis.window = originalWindow;
            globalThis.document = originalDoc;
        }
    });
});
