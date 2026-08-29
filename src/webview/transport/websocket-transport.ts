/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebviewTransport } from './types';

/**
 * WebSocket Transport for self-hosted Web / Browser client.
 */
export class WebSocketWebviewTransport implements WebviewTransport {
    private socket?: WebSocket;
    private readonly messageQueue: unknown[] = [];
    private readonly handlers = new Set<(message: unknown) => void>();
    private _disposed = false;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private reconnectAttempts = 0;

    public static readonly MAX_QUEUE_SIZE = 100;

    constructor(private readonly url: string) {
        this.connect();
    }

    private connect(): void {
        if (this._disposed || typeof WebSocket === 'undefined') {
            return;
        }

        this.socket = new WebSocket(this.url);

        this.socket.onopen = () => {
            this.reconnectAttempts = 0;
            while (this.messageQueue.length > 0) {
                const msg = this.messageQueue.shift();
                if (msg === undefined) {
                    continue;
                }
                try {
                    this.socket?.send(JSON.stringify(msg));
                } catch (err) {
                    console.error('[WebSocketWebviewTransport] Failed to send queued message:', err);
                }
            }
        };

        this.socket.onmessage = (event: MessageEvent) => {
            let data: unknown;
            try {
                data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
            } catch {
                // Ignore malformed message payloads
                return;
            }

            for (const handler of Array.from(this.handlers)) {
                try {
                    handler(data);
                } catch (err) {
                    console.error('[WebSocketWebviewTransport] Error in onMessage subscriber:', err);
                }
            }
        };

        this.socket.onerror = (err) => {
            console.error('[WebSocketWebviewTransport] WebSocket connection error:', err);
        };

        this.socket.onclose = () => {
            if (!this._disposed) {
                this.scheduleReconnect();
            }
        };
    }

    private scheduleReconnect(): void {
        if (this._disposed || this.reconnectTimer) {
            return;
        }

        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 5000);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, delay);
    }

    public postMessage(message: unknown): void {
        const isSocketOpen =
            this.socket &&
            (this.socket.readyState === 1 ||
                (typeof WebSocket !== 'undefined' && this.socket.readyState === WebSocket.OPEN));
        if (isSocketOpen) {
            try {
                this.socket?.send(JSON.stringify(message));
            } catch (err) {
                console.error('[WebSocketWebviewTransport] Failed to send message:', err);
            }
            return;
        }

        if (this.messageQueue.length >= WebSocketWebviewTransport.MAX_QUEUE_SIZE) {
            this.messageQueue.shift();
        }
        this.messageQueue.push(message);
    }

    public onMessage(handler: (message: unknown) => void): () => void {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }

    public dispose(): void {
        this._disposed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.socket) {
            this.socket.onopen = null;
            this.socket.onmessage = null;
            this.socket.onerror = null;
            this.socket.onclose = null;
            this.socket.close();
            this.socket = undefined;
        }
        this.handlers.clear();
        this.messageQueue.length = 0;
    }
}
