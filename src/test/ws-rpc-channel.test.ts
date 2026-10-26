/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEBSOCKET_OPEN, type WebSocketLike, WsRpcChannel, WsTransportError } from '../core/host/ws-rpc-channel';

const CONNECTING = 0;
const CLOSED = 3;

class FakeWebSocket implements WebSocketLike {
    public readyState = CONNECTING;
    public readonly sent: string[] = [];
    public closedWith: { code?: number; reason?: string } | null = null;
    public onopen: ((ev: Event) => void) | null = null;
    public onmessage: ((ev: MessageEvent) => void) | null = null;
    public onclose: ((ev: CloseEvent) => void) | null = null;
    public onerror: ((ev: Event) => void) | null = null;

    send(data: string): void {
        if (this.readyState !== WEBSOCKET_OPEN) {
            throw new Error('not open');
        }
        this.sent.push(data);
    }

    close(code?: number, reason?: string): void {
        if (this.readyState === CLOSED) {
            return;
        }
        this.closedWith = { code, reason };
        this.serverClose(code ?? 1005, reason ?? '');
    }

    open(): void {
        this.readyState = WEBSOCKET_OPEN;
        this.onopen?.(new Event('open'));
    }

    receive(message: unknown): void {
        const data = typeof message === 'string' ? message : JSON.stringify(message);
        this.onmessage?.(new MessageEvent('message', { data }));
    }

    serverClose(code: number, reason: string): void {
        this.readyState = CLOSED;
        // Node 22 has no global CloseEvent; a plain Event carrying the same fields is enough for the handler.
        const event = Object.assign(new Event('close'), { code, reason, wasClean: true }) as CloseEvent;
        this.onclose?.(event);
    }

    lastSent(): Record<string, unknown> {
        const last = this.sent[this.sent.length - 1];
        if (last === undefined) {
            throw new Error('nothing sent');
        }
        return JSON.parse(last) as Record<string, unknown>;
    }
}

function setup(options?: { keepaliveIntervalMs?: number; keepaliveTimeoutMs?: number; maxReconnectAttempts?: number }) {
    const sockets: FakeWebSocket[] = [];
    const logs: string[] = [];
    const notifications: Array<{ method: string; params: unknown }> = [];
    const channel = new WsRpcChannel({
        url: 'ws://127.0.0.1:1/api/ws',
        factory: () => {
            const socket = new FakeWebSocket();
            sockets.push(socket);
            return socket;
        },
        keepaliveIntervalMs: options?.keepaliveIntervalMs ?? 0,
        keepaliveTimeoutMs: options?.keepaliveTimeoutMs,
        reconnectDelayMs: 100,
        maxReconnectAttempts: options?.maxReconnectAttempts ?? 3,
        onNotification: (method, params) => notifications.push({ method, params }),
        log: (message) => logs.push(message),
    });
    channel.connect();
    const socket = sockets[0];
    if (!socket) {
        throw new Error('factory not invoked');
    }
    return { channel, socket, sockets, logs, notifications };
}

function frame(id: number | string, method: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id, method });
}

describe('WsRpcChannel', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('is not open until the socket opens, and rejects requests before then', async () => {
        const { channel, socket } = setup();
        expect(channel.isOpen).toBe(false);
        await expect(channel.request(1, 'x', frame(1, 'x'), new AbortController().signal)).rejects.toBeInstanceOf(
            WsTransportError,
        );
        socket.open();
        expect(channel.isOpen).toBe(true);
    });

    it('correlates out-of-order responses by id', async () => {
        const { channel, socket } = setup();
        socket.open();
        const signal = new AbortController().signal;

        const first = channel.request(1, 'a', frame(1, 'a'), signal);
        const second = channel.request(2, 'b', frame(2, 'b'), signal);
        expect(socket.sent).toHaveLength(2);

        socket.receive({ jsonrpc: '2.0', id: 2, result: 'B' });
        socket.receive({ jsonrpc: '2.0', id: 1, result: 'A' });

        await expect(second).resolves.toMatchObject({ id: 2, result: 'B' });
        await expect(first).resolves.toMatchObject({ id: 1, result: 'A' });
    });

    it('distinguishes numeric and string ids', async () => {
        const { channel, socket } = setup();
        socket.open();
        const signal = new AbortController().signal;
        const numeric = channel.request(7, 'a', frame(7, 'a'), signal);
        const text = channel.request('7', 'b', frame('7', 'b'), signal);

        socket.receive({ jsonrpc: '2.0', id: '7', result: 'text' });
        socket.receive({ jsonrpc: '2.0', id: 7, result: 'numeric' });

        await expect(text).resolves.toMatchObject({ result: 'text' });
        await expect(numeric).resolves.toMatchObject({ result: 'numeric' });
    });

    it('reassembles $/chunk frames, tolerating out-of-order delivery', async () => {
        const { channel, socket } = setup();
        socket.open();
        const pending = channel.request(5, 'fs.readFiles', frame(5, 'fs.readFiles'), new AbortController().signal);

        const encoded = JSON.stringify({ jsonrpc: '2.0', id: 5, result: { content: 'x'.repeat(50) } });
        const size = Math.ceil(encoded.length / 3);
        const parts = [encoded.slice(0, size), encoded.slice(size, 2 * size), encoded.slice(2 * size)];
        const chunk = (seq: number) => ({
            jsonrpc: '2.0',
            method: '$/chunk',
            params: { id: 5, seq, last: seq === 2, data: parts[seq] },
        });

        socket.receive(chunk(1));
        socket.receive(chunk(0));
        socket.receive(chunk(2));

        await expect(pending).resolves.toMatchObject({ id: 5, result: { content: 'x'.repeat(50) } });
    });

    it('rejects with a transport error when chunked payload is not valid JSON', async () => {
        const { channel, socket } = setup();
        socket.open();
        const pending = channel.request(9, 'm', frame(9, 'm'), new AbortController().signal);
        socket.receive({ jsonrpc: '2.0', method: '$/chunk', params: { id: 9, seq: 0, last: true, data: '{not json' } });
        await expect(pending).rejects.toBeInstanceOf(WsTransportError);
    });

    it('rejects with the abort reason and ignores a late response', async () => {
        const { channel, socket } = setup();
        socket.open();
        const controller = new AbortController();
        const pending = channel.request(3, 'slow', frame(3, 'slow'), controller.signal);

        const reason = new Error('caller gave up');
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);

        // Late reply must not throw or leak.
        socket.receive({ jsonrpc: '2.0', id: 3, result: 'too late' });
    });

    it('fails in-flight requests when the socket closes and reconnects with backoff', async () => {
        const { channel, socket, sockets } = setup();
        socket.open();
        const pending = channel.request(4, 'm', frame(4, 'm'), new AbortController().signal);

        socket.serverClose(1006, 'gone');
        await expect(pending).rejects.toBeInstanceOf(WsTransportError);
        expect(channel.isOpen).toBe(false);
        expect(sockets).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(100);
        expect(sockets).toHaveLength(2);
        sockets[1]?.open();
        expect(channel.isOpen).toBe(true);
    });

    it('stops reconnecting after maxReconnectAttempts', async () => {
        const { socket, sockets, logs } = setup({ maxReconnectAttempts: 2 });
        socket.open();
        socket.serverClose(1006, '');
        await vi.advanceTimersByTimeAsync(100); // attempt 1
        sockets[1]?.serverClose(1006, '');
        await vi.advanceTimersByTimeAsync(200); // attempt 2
        sockets[2]?.serverClose(1006, '');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(sockets).toHaveLength(3);
        expect(logs.some((l) => l.includes('giving up'))).toBe(true);
    });

    it('routes non-response frames with a method to onNotification', () => {
        const { socket, notifications } = setup();
        socket.open();
        socket.receive({ jsonrpc: '2.0', method: 'watcher.change', params: { subscriptionId: 's1', events: [] } });
        expect(notifications).toEqual([{ method: 'watcher.change', params: { subscriptionId: 's1', events: [] } }]);
    });

    it('notify() sends when open and reports false otherwise', () => {
        const { channel, socket } = setup();
        expect(channel.notify('{"jsonrpc":"2.0","method":"x"}')).toBe(false);
        socket.open();
        expect(channel.notify('{"jsonrpc":"2.0","method":"x"}')).toBe(true);
        expect(socket.lastSent()).toMatchObject({ method: 'x' });
    });

    it('sends $/ping on the keepalive interval and logs the round trip', async () => {
        const { socket, logs } = setup({ keepaliveIntervalMs: 1000, keepaliveTimeoutMs: 500 });
        socket.open();

        await vi.advanceTimersByTimeAsync(1000);
        const ping = socket.lastSent();
        expect(ping.method).toBe('$/ping');

        socket.receive({ jsonrpc: '2.0', id: ping.id, result: { t: 1 } });
        await vi.advanceTimersByTimeAsync(0);
        expect(logs.some((l) => l.includes('keepalive rtt='))).toBe(true);
        expect(socket.readyState).toBe(WEBSOCKET_OPEN);
    });

    it('closes the socket when a keepalive goes unanswered', async () => {
        const { socket } = setup({ keepaliveIntervalMs: 1000, keepaliveTimeoutMs: 500 });
        socket.open();

        await vi.advanceTimersByTimeAsync(1000);
        expect(socket.lastSent().method).toBe('$/ping');
        await vi.advanceTimersByTimeAsync(500);

        expect(socket.readyState).toBe(CLOSED);
        expect(socket.closedWith?.code).toBe(4000);
    });

    it('dispose closes the socket and does not reconnect', async () => {
        const { channel, socket, sockets } = setup();
        socket.open();
        channel.dispose();
        expect(socket.closedWith?.code).toBe(1000);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(sockets).toHaveLength(1);
        expect(channel.isOpen).toBe(false);
    });
});
