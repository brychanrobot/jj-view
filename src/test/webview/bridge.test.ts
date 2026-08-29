/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getWebviewTransport,
    MockWebviewTransport,
    setWebviewTransport,
    VsCodeWebviewTransport,
    WebSocketWebviewTransport,
} from '../../webview/transport';

class MockMessageEvent extends Event {
    public readonly data: unknown;
    constructor(type: string, init?: { data?: unknown }) {
        super(type);
        this.data = init?.data;
    }
}

class MockWebSocket {
    public static readonly CONNECTING = 0;
    public static readonly OPEN = 1;
    public static readonly CLOSING = 2;
    public static readonly CLOSED = 3;

    public static instance?: MockWebSocket;
    public readonly url: string;
    public readyState = 0;
    public send = vi.fn();
    public close = vi.fn();
    public onopen?: (() => void) | null;
    public onmessage?: ((event: { data: unknown }) => void) | null;
    public onerror?: ((event: Event) => void) | null;
    public onclose?: ((event: CloseEvent) => void) | null;

    constructor(url: string) {
        this.url = url;
        MockWebSocket.instance = this;
    }
}

describe('WebviewTransport', () => {
    afterEach(() => {
        setWebviewTransport(undefined);
        vi.restoreAllMocks();
    });

    describe('MockWebviewTransport', () => {
        it('captures sent messages', () => {
            const transport = new MockWebviewTransport();

            transport.postMessage({ type: 'testMessage', payload: { foo: 'bar' } });
            expect(transport.sentMessages).toEqual([{ type: 'testMessage', payload: { foo: 'bar' } }]);

            transport.clear();
            expect(transport.sentMessages).toEqual([]);
        });

        it('dispatches messages to registered onMessage listeners', () => {
            const transport = new MockWebviewTransport();
            const received: unknown[] = [];

            const unsubscribe = transport.onMessage((msg) => {
                received.push(msg);
            });

            transport.simulateIncomingMessage({ type: 'update', commits: [] });
            expect(received).toEqual([{ type: 'update', commits: [] }]);

            unsubscribe();
            transport.simulateIncomingMessage({ type: 'update', commits: ['c1'] });
            expect(received).toHaveLength(1);
        });

        it('clears registered handlers on clear()', () => {
            const transport = new MockWebviewTransport();
            const received: unknown[] = [];

            transport.onMessage((msg) => {
                received.push(msg);
            });

            transport.clear();
            transport.simulateIncomingMessage({ type: 'update' });
            expect(received).toHaveLength(0);
        });

        it('isolates subscriber errors during dispatch', () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const transport = new MockWebviewTransport();
            const received: unknown[] = [];

            transport.onMessage(() => {
                throw new Error('Subscriber 1 threw');
            });
            transport.onMessage((msg) => {
                received.push(msg);
            });

            transport.simulateIncomingMessage({ type: 'test' });
            expect(received).toEqual([{ type: 'test' }]);
            expect(consoleErrorSpy).toHaveBeenCalled();
            consoleErrorSpy.mockRestore();
        });
    });

    describe('VsCodeWebviewTransport', () => {
        let postMessageMock: (message: unknown) => void;
        let originalWindow: unknown;
        let mockEventTarget: EventTarget;

        beforeEach(() => {
            postMessageMock = vi.fn();
            mockEventTarget = new EventTarget();
            originalWindow = (globalThis as { window?: unknown }).window;

            (globalThis as { window?: unknown }).window = Object.assign(mockEventTarget, {
                acquireVsCodeApi: () => ({
                    postMessage: postMessageMock,
                }),
                addEventListener: mockEventTarget.addEventListener.bind(mockEventTarget),
                removeEventListener: mockEventTarget.removeEventListener.bind(mockEventTarget),
                dispatchEvent: mockEventTarget.dispatchEvent.bind(mockEventTarget),
            });
        });

        afterEach(() => {
            (globalThis as { window?: unknown }).window = originalWindow;
        });

        it('sends messages through acquireVsCodeApi postMessage', () => {
            const transport = new VsCodeWebviewTransport();
            transport.postMessage({ type: 'webviewLoaded' });

            expect(postMessageMock).toHaveBeenCalledWith({ type: 'webviewLoaded' });
        });

        it('listens for window message events and cleans up listener on unsubscribe', () => {
            const transport = new VsCodeWebviewTransport();
            const received: unknown[] = [];

            const unsubscribe = transport.onMessage((msg) => {
                received.push(msg);
            });

            const target = (globalThis as { window?: EventTarget }).window;
            target?.dispatchEvent(
                new MockMessageEvent('message', {
                    data: { type: 'update', commits: [] },
                }),
            );

            expect(received).toEqual([{ type: 'update', commits: [] }]);

            unsubscribe();

            target?.dispatchEvent(
                new MockMessageEvent('message', {
                    data: { type: 'update', commits: ['new'] },
                }),
            );

            expect(received).toHaveLength(1);
        });

        it('isolates subscriber errors in message listener', () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const transport = new VsCodeWebviewTransport();
            const received: unknown[] = [];

            transport.onMessage(() => {
                throw new Error('VsCode subscriber error');
            });
            transport.onMessage((msg) => {
                received.push(msg);
            });

            const target = (globalThis as { window?: EventTarget }).window;
            target?.dispatchEvent(
                new MockMessageEvent('message', {
                    data: { type: 'update' },
                }),
            );

            expect(received).toEqual([{ type: 'update' }]);
            expect(consoleErrorSpy).toHaveBeenCalled();
            consoleErrorSpy.mockRestore();
            transport.dispose();
        });

        it('cleans up listeners on dispose()', () => {
            const transport = new VsCodeWebviewTransport();
            const received: unknown[] = [];

            transport.onMessage((msg) => {
                received.push(msg);
            });

            transport.dispose();

            const target = (globalThis as { window?: EventTarget }).window;
            target?.dispatchEvent(
                new MockMessageEvent('message', {
                    data: { type: 'update' },
                }),
            );

            expect(received).toHaveLength(0);
        });

        it('reuses cached acquireVsCodeApi across multiple instances', () => {
            const transport1 = new VsCodeWebviewTransport();
            const transport2 = new VsCodeWebviewTransport();

            transport1.postMessage({ msg: 1 });
            transport2.postMessage({ msg: 2 });

            expect(postMessageMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('WebSocketWebviewTransport', () => {
        let originalWebSocket: typeof WebSocket | undefined;

        beforeEach(() => {
            originalWebSocket = globalThis.WebSocket;
            MockWebSocket.instance = undefined;
            (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
        });

        afterEach(() => {
            globalThis.WebSocket = originalWebSocket as typeof WebSocket;
        });

        it('queues messages before socket is open and sends on connect', () => {
            const transport = new WebSocketWebviewTransport('ws://localhost:8080/rpc');

            const socket = MockWebSocket.instance;
            expect(socket).toBeDefined();

            transport.postMessage({ type: 'queued1' });
            expect(socket?.send).not.toHaveBeenCalled();

            if (socket) {
                socket.readyState = 1; // OPEN
                socket.onopen?.();
            }

            expect(socket?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'queued1' }));

            transport.postMessage({ type: 'immediate' });
            expect(socket?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'immediate' }));

            transport.dispose();
            expect(socket?.close).toHaveBeenCalled();
            expect(socket?.onopen).toBeNull();
            expect(socket?.onmessage).toBeNull();
        });

        it('bounds outbound message queue to MAX_QUEUE_SIZE', () => {
            const transport = new WebSocketWebviewTransport('ws://localhost:8080/rpc');
            const socket = MockWebSocket.instance;
            expect(socket).toBeDefined();

            for (let i = 0; i < 110; i++) {
                transport.postMessage({ seq: i });
            }

            if (socket) {
                socket.readyState = 1;
                socket.onopen?.();
            }

            expect(socket?.send).toHaveBeenCalledTimes(100);
            expect(socket?.send).toHaveBeenCalledWith(JSON.stringify({ seq: 10 }));
            expect(socket?.send).toHaveBeenCalledWith(JSON.stringify({ seq: 109 }));
            transport.dispose();
        });

        it('handles postMessage exceptions gracefully when socket throws', () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const transport = new WebSocketWebviewTransport('ws://localhost:8080/rpc');
            const socket = MockWebSocket.instance;

            if (socket) {
                socket.readyState = 1;
                socket.send.mockImplementation(() => {
                    throw new Error('Socket send failed');
                });
            }

            expect(() => transport.postMessage({ type: 'fail' })).not.toThrow();
            expect(consoleErrorSpy).toHaveBeenCalled();
            consoleErrorSpy.mockRestore();
            transport.dispose();
        });

        it('parses incoming JSON messages and dispatches to listeners', () => {
            const transport = new WebSocketWebviewTransport('ws://localhost:8080/rpc');
            const received: unknown[] = [];

            const unsubscribe = transport.onMessage((msg) => {
                received.push(msg);
            });

            const socket = MockWebSocket.instance;
            expect(socket).toBeDefined();

            socket?.onmessage?.({
                data: JSON.stringify({ type: 'update', data: 42 }),
            });

            expect(received).toEqual([{ type: 'update', data: 42 }]);

            unsubscribe();

            socket?.onmessage?.({
                data: JSON.stringify({ type: 'update', data: 43 }),
            });

            expect(received).toHaveLength(1);
        });

        it('safely handles malformed JSON without crashing listeners', () => {
            const transport = new WebSocketWebviewTransport('ws://localhost:8080/rpc');
            const received: unknown[] = [];

            transport.onMessage((msg) => {
                received.push(msg);
            });

            const socket = MockWebSocket.instance;
            socket?.onmessage?.({
                data: 'invalid json{',
            });

            expect(received).toHaveLength(0);
        });

        it('isolates subscriber errors in WebSocket listener', () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const transport = new WebSocketWebviewTransport('ws://localhost:8080/rpc');
            const received: unknown[] = [];

            transport.onMessage(() => {
                throw new Error('Subscriber error');
            });
            transport.onMessage((msg) => {
                received.push(msg);
            });

            const socket = MockWebSocket.instance;
            socket?.onmessage?.({
                data: JSON.stringify({ type: 'update' }),
            });

            expect(received).toEqual([{ type: 'update' }]);
            expect(consoleErrorSpy).toHaveBeenCalled();
            consoleErrorSpy.mockRestore();
        });

        it('reconnects automatically on socket close', () => {
            vi.useFakeTimers();
            const transport = new WebSocketWebviewTransport('ws://localhost:8080/rpc');
            const initialSocket = MockWebSocket.instance;
            expect(initialSocket).toBeDefined();

            // Simulate connection close
            initialSocket?.onclose?.({} as CloseEvent);

            // Fast-forward past reconnect timer (1000ms)
            vi.advanceTimersByTime(1100);

            // A new MockWebSocket should have been instantiated
            expect(MockWebSocket.instance).not.toBe(initialSocket);

            transport.dispose();
            vi.useRealTimers();
        });
    });

    describe('getWebviewTransport & setWebviewTransport', () => {
        it('returns custom transport if overridden', () => {
            const custom = new MockWebviewTransport();
            setWebviewTransport(custom);

            expect(getWebviewTransport()).toBe(custom);
        });

        it('disposes previous transport when setWebviewTransport is called', () => {
            const disposeSpy = vi.fn();
            const transport = new MockWebviewTransport();
            transport.dispose = disposeSpy;

            setWebviewTransport(transport);
            setWebviewTransport(undefined);

            expect(disposeSpy).toHaveBeenCalled();
        });

        it('returns MockWebviewTransport in headless/node runtime and caches it', () => {
            const transport1 = getWebviewTransport();
            const transport2 = getWebviewTransport();

            expect(transport1).toBeInstanceOf(MockWebviewTransport);
            expect(transport1).toBe(transport2);
        });

        it('returns VsCodeWebviewTransport when window.acquireVsCodeApi is present', () => {
            const originalWindow = (globalThis as { window?: unknown }).window;
            (globalThis as { window?: unknown }).window = {
                acquireVsCodeApi: () => ({ postMessage: vi.fn() }),
            };

            setWebviewTransport(undefined);
            const transport = getWebviewTransport();
            expect(transport).toBeInstanceOf(VsCodeWebviewTransport);

            (globalThis as { window?: unknown }).window = originalWindow;
        });

        it('returns WebSocketWebviewTransport in browser runtime with location.host or __JJ_VIEW_WS_URL__', () => {
            const originalWindow = (globalThis as { window?: unknown }).window;
            (globalThis as { window?: unknown }).window = {
                location: {
                    protocol: 'http:',
                    host: 'localhost:3000',
                },
                __JJ_VIEW_WS_URL__: 'ws://localhost:3000/custom-ws',
            };

            setWebviewTransport(undefined);
            const transport = getWebviewTransport();
            expect(transport).toBeInstanceOf(WebSocketWebviewTransport);

            (globalThis as { window?: unknown }).window = originalWindow;
        });
    });
});
