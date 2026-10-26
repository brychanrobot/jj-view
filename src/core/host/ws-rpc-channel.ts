/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client side of the WebSocket RPC channel (`/api/ws`).
 *
 * Carries the same JSON-RPC 2.0 frames as `/api/rpc`, multiplexed over one
 * long-lived socket. {@link RemoteHostSystem} routes each request here when
 * the socket is open and falls back to HTTP otherwise, so this class only has
 * to get three things right:
 *
 * 1. Correlate responses to requests by id, including reassembling responses
 *    the daemon split into `$/chunk` frames.
 * 2. Detect a dead socket quickly (application-level `$/ping` keepalive) and
 *    reconnect with backoff.
 * 3. Fail in-flight requests when the socket drops. They are deliberately not
 *    replayed over HTTP: the daemon may already have executed them, and most
 *    RPCs (jj mutations, file writes) are not idempotent.
 */

export interface WebSocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((ev: Event) => void) | null;
    onmessage: ((ev: MessageEvent) => void) | null;
    onclose: ((ev: CloseEvent) => void) | null;
    onerror: ((ev: Event) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** `WebSocket.OPEN`; duplicated so this module does not depend on the DOM global. */
export const WEBSOCKET_OPEN = 1;

export interface JsonRpcResponseFrame {
    readonly jsonrpc: '2.0';
    readonly id: number | string | null;
    readonly result?: unknown;
    readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface WsRpcChannelOptions {
    readonly url: string;
    readonly factory: WebSocketFactory;
    /** How often to send `$/ping` while open. Default 20s. */
    readonly keepaliveIntervalMs?: number;
    /** How long to wait for a `$/ping` reply before declaring the socket dead. Default 10s. */
    readonly keepaliveTimeoutMs?: number;
    /** Base reconnect delay; multiplied by the attempt number up to 5x. Default 1s. */
    readonly reconnectDelayMs?: number;
    /** Give up reconnecting after this many consecutive failures. Default 10. */
    readonly maxReconnectAttempts?: number;
    /** Receives server->client notifications that arrive on the socket. */
    readonly onNotification?: (method: string, params: unknown) => void;
    /** Diagnostic sink; messages are already prefixed. */
    readonly log?: (message: string) => void;
}

/** Thrown when a request was sent but the socket closed before a response arrived. */
export class WsTransportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WsTransportError';
    }
}

interface PendingRequest {
    readonly method: string;
    readonly resolve: (response: JsonRpcResponseFrame) => void;
    readonly reject: (err: Error) => void;
    readonly cleanup: () => void;
}

interface ChunkParams {
    readonly id: number | string | null;
    readonly seq: number;
    readonly last: boolean;
    readonly data: string;
}

const PING_METHOD = '$/ping';
const CHUNK_METHOD = '$/chunk';

function isChunkParams(value: unknown): value is ChunkParams {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    if (!('id' in value) || !('seq' in value) || !('last' in value) || !('data' in value)) {
        return false;
    }
    return typeof value.seq === 'number' && typeof value.last === 'boolean' && typeof value.data === 'string';
}

function isResponseFrame(value: unknown): value is JsonRpcResponseFrame {
    if (typeof value !== 'object' || value === null || !('id' in value)) {
        return false;
    }
    const id = value.id;
    return typeof id === 'number' || typeof id === 'string' || id === null;
}

function idKey(id: number | string | null): string {
    return id === null ? 'null' : `${typeof id}:${id}`;
}

export class WsRpcChannel {
    private readonly _options: WsRpcChannelOptions;
    private _socket: WebSocketLike | null = null;
    private readonly _pending = new Map<string, PendingRequest>();
    private readonly _chunks = new Map<string, string[]>();
    private _reconnectAttempts = 0;
    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private _keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    private _pingSeq = 0;
    private _disposed = false;
    private _connectStartedAt = 0;

    constructor(options: WsRpcChannelOptions) {
        this._options = options;
    }

    public get isOpen(): boolean {
        return this._socket !== null && this._socket.readyState === WEBSOCKET_OPEN;
    }

    public connect(): void {
        if (this._disposed || this._socket) {
            return;
        }
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }

        this._connectStartedAt = performance.now();
        let socket: WebSocketLike;
        try {
            socket = this._options.factory(this._options.url);
        } catch (err) {
            this._log(`connect failed: ${err instanceof Error ? err.message : String(err)}`);
            this._scheduleReconnect();
            return;
        }
        this._socket = socket;

        socket.onopen = () => this._handleOpen();
        socket.onmessage = (event) => this._handleMessage(event.data);
        socket.onclose = (event) => this._handleClose(event.code, event.reason);
        socket.onerror = () => {
            // The error event carries no detail; the close event that follows does.
        };
    }

    public dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this._stopKeepalive();
        const socket = this._socket;
        this._socket = null;
        if (socket) {
            try {
                socket.close(1000, 'disposed');
            } catch {
                // Ignore close errors on teardown
            }
        }
        this._failPending(new WsTransportError('WebSocket channel disposed'));
    }

    /**
     * Sends an already-serialized request frame and resolves with the raw
     * response frame. Rejects with {@link WsTransportError} if the socket
     * closes first, or with `signal.reason` if aborted. The caller owns
     * timeout and cancellation semantics.
     */
    public request(
        id: number | string,
        method: string,
        frame: string,
        signal: AbortSignal,
    ): Promise<JsonRpcResponseFrame> {
        const socket = this._socket;
        if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
            return Promise.reject(new WsTransportError('WebSocket is not open'));
        }
        if (signal.aborted) {
            return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
        }

        const key = idKey(id);
        return new Promise<JsonRpcResponseFrame>((resolve, reject) => {
            const onAbort = () => {
                this._pending.delete(key);
                this._chunks.delete(key);
                reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            this._pending.set(key, {
                method,
                resolve,
                reject,
                cleanup: () => signal.removeEventListener('abort', onAbort),
            });
            try {
                socket.send(frame);
            } catch (err) {
                this._pending.delete(key);
                signal.removeEventListener('abort', onAbort);
                reject(new WsTransportError(`send failed: ${err instanceof Error ? err.message : String(err)}`));
            }
        });
    }

    /** Sends a notification frame. Returns false if the socket is not open. */
    public notify(frame: string): boolean {
        const socket = this._socket;
        if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
            return false;
        }
        try {
            socket.send(frame);
            return true;
        } catch {
            return false;
        }
    }

    private _handleOpen(): void {
        this._reconnectAttempts = 0;
        this._log(`open in ${(performance.now() - this._connectStartedAt).toFixed(0)}ms`);
        this._startKeepalive();
    }

    private _handleClose(code: number, reason: string): void {
        const wasOpen = this._socket !== null;
        this._socket = null;
        this._stopKeepalive();
        this._chunks.clear();
        this._failPending(new WsTransportError(`WebSocket closed (code=${code}${reason ? ` reason=${reason}` : ''})`));
        if (this._disposed) {
            return;
        }
        if (wasOpen) {
            this._log(`closed code=${code}${reason ? ` reason=${reason}` : ''}`);
        }
        this._scheduleReconnect();
    }

    private _scheduleReconnect(): void {
        if (this._disposed || this._reconnectTimer) {
            return;
        }
        const maxAttempts = this._options.maxReconnectAttempts ?? 10;
        if (this._reconnectAttempts >= maxAttempts) {
            this._log(`giving up after ${maxAttempts} attempts; requests continue over HTTP`);
            return;
        }
        this._reconnectAttempts++;
        const delay = (this._options.reconnectDelayMs ?? 1000) * Math.min(this._reconnectAttempts, 5);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private _failPending(err: Error): void {
        const pending = Array.from(this._pending.values());
        this._pending.clear();
        for (const entry of pending) {
            entry.cleanup();
            entry.reject(err);
        }
    }

    private _handleMessage(data: unknown): void {
        if (typeof data !== 'string') {
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch {
            return;
        }
        if (typeof parsed !== 'object' || parsed === null) {
            return;
        }

        if ('method' in parsed && parsed.method === CHUNK_METHOD) {
            this._handleChunk('params' in parsed ? parsed.params : undefined);
            return;
        }
        if (isResponseFrame(parsed)) {
            this._settle(parsed);
            return;
        }
        if ('method' in parsed && typeof parsed.method === 'string') {
            this._options.onNotification?.(parsed.method, 'params' in parsed ? parsed.params : undefined);
        }
    }

    private _handleChunk(params: unknown): void {
        if (!isChunkParams(params)) {
            return;
        }
        const key = idKey(params.id);
        let parts = this._chunks.get(key);
        if (!parts) {
            parts = [];
            this._chunks.set(key, parts);
        }
        parts[params.seq] = params.data;
        if (!params.last) {
            return;
        }
        this._chunks.delete(key);
        let assembled: unknown;
        try {
            assembled = JSON.parse(parts.join(''));
        } catch {
            const pending = this._pending.get(key);
            if (pending) {
                this._pending.delete(key);
                pending.cleanup();
                pending.reject(new WsTransportError('malformed chunked response'));
            }
            return;
        }
        if (isResponseFrame(assembled)) {
            this._settle(assembled);
        }
    }

    private _settle(response: JsonRpcResponseFrame): void {
        if (response.id === null) {
            return;
        }
        const key = idKey(response.id);
        const pending = this._pending.get(key);
        if (!pending) {
            // Already aborted/timed out locally, or a reply to a request that went over HTTP.
            return;
        }
        this._pending.delete(key);
        pending.cleanup();
        pending.resolve(response);
    }

    private _startKeepalive(): void {
        this._stopKeepalive();
        const interval = this._options.keepaliveIntervalMs ?? 20_000;
        if (interval <= 0) {
            return;
        }
        this._keepaliveTimer = setInterval(() => void this._ping(), interval);
    }

    private _stopKeepalive(): void {
        if (this._keepaliveTimer) {
            clearInterval(this._keepaliveTimer);
            this._keepaliveTimer = null;
        }
    }

    private async _ping(): Promise<void> {
        const socket = this._socket;
        if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
            return;
        }
        const id = `ping-${++this._pingSeq}`;
        const controller = new AbortController();
        const timeout = this._options.keepaliveTimeoutMs ?? 10_000;
        const timer = setTimeout(() => controller.abort(new Error('keepalive timeout')), timeout);
        const start = performance.now();
        try {
            await this.request(
                id,
                PING_METHOD,
                JSON.stringify({ jsonrpc: '2.0', id, method: PING_METHOD }),
                controller.signal,
            );
            this._log(`keepalive rtt=${(performance.now() - start).toFixed(1)}ms`);
        } catch (err) {
            if (controller.signal.aborted && this._socket === socket) {
                this._log(`keepalive timed out after ${timeout}ms; closing socket`);
                try {
                    socket.close(4000, 'keepalive timeout');
                } catch {
                    // onclose will still fire and drive the reconnect
                }
            } else if (!(err instanceof WsTransportError)) {
                this._log(`keepalive failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        } finally {
            clearTimeout(timer);
        }
    }

    private _log(message: string): void {
        this._options.log?.(`[Perf:WS] ${message}`);
    }
}
