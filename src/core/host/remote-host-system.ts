/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    type FileStat,
    type HelperScriptName,
    type HostFs,
    type HostPlatform,
    type HostProcess,
    type HostSystem,
    type HostWatcher,
    type ProcessExecOptions,
    ProcessExitError,
    type ProcessResult,
    type ScratchExecRequest,
    type ScratchExecResult,
    type TrackableProcess,
    type WatchEvent,
    type WatcherSubscription,
    type WatchOptions,
} from './host-system';
import { type WebSocketFactory, type WebSocketLike, WsRpcChannel, WsTransportError } from './ws-rpc-channel';

export const RPC_CODE_PARSE_ERROR = -32700;
export const RPC_CODE_INVALID_REQUEST = -32600;
export const RPC_CODE_METHOD_NOT_FOUND = -32601;
export const RPC_CODE_INVALID_PARAMS = -32602;
export const RPC_CODE_INTERNAL_ERROR = -32603;
export const RPC_CODE_PROCESS_ERROR = -32000;
export const RPC_CODE_SECURITY_ERROR = -32001;
export const RPC_CODE_REQUEST_CANCELLED = -32800;

export class HostSystemError extends Error {
    constructor(
        message: string,
        public readonly code?: string,
    ) {
        super(message);
        this.name = 'HostSystemError';
    }
}

export interface EventSourceLike {
    readonly readyState: number;
    close(): void;
    onopen: ((ev: Event) => void) | null;
    onmessage: ((ev: MessageEvent) => void) | null;
    onerror: ((ev: Event) => void) | null;
}

export interface RemoteHostSystemOptions {
    readonly url?: string;
    readonly token?: string;
    readonly platform?: HostPlatform;
    readonly tempDir?: string;
    readonly clientId?: string;
    readonly fetch?: typeof fetch;
    readonly eventSourceFactory?: (url: string) => EventSourceLike;
    /**
     * Factory for the WebSocket RPC channel. Defaults to the global
     * `WebSocket` when available. The channel is an accelerator: requests fall
     * back to HTTP POST whenever it is not open.
     */
    readonly webSocketFactory?: WebSocketFactory;
    /** Set false to never open the WebSocket channel. Default true. */
    readonly useWebSocket?: boolean;
    readonly autoConnect?: boolean;
    readonly reconnect?: boolean;
    readonly reconnectDelayMs?: number;
    readonly maxReconnectAttempts?: number;
    readonly requestTimeoutMs?: number;
    readonly csrfToken?: string;
}

interface JsonRpcRequest {
    readonly jsonrpc: '2.0';
    readonly id?: number | string;
    readonly method: string;
    readonly params?: unknown;
}

interface JsonRpcError {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
}

interface JsonRpcResponse {
    readonly jsonrpc: '2.0';
    readonly id: number | string | null;
    readonly result?: unknown;
    readonly error?: JsonRpcError;
}

interface JsonRpcNotification {
    readonly jsonrpc: '2.0';
    readonly method: string;
    readonly params?: unknown;
}

function generateRandomId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const rand = Math.random().toString(36).slice(2);
    const time = Date.now().toString(36);
    return `${rand}${time}`;
}

interface ActiveWatcherSubscription {
    readonly dirPath: string;
    readonly options?: WatchOptions;
    readonly callback: (err: Error | null, events: WatchEvent[]) => void;
    subscriptionId: string;
}

function base64ToUint8Array(base64: string): Uint8Array {
    const binString = atob(base64);
    const len = binString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binString.charCodeAt(i);
    }
    return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x2000; // 8192 - safe for Safari/WebKit argument stack limits
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

function isProcessExitData(data: unknown): data is { exitCode: number; stdout: string; stderr: string } {
    if (typeof data !== 'object' || data === null) {
        return false;
    }
    const d = data as Record<string, unknown>;
    return typeof d.exitCode === 'number' && typeof d.stdout === 'string' && typeof d.stderr === 'string';
}

interface RawFileStat {
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly isSymbolicLink: boolean;
    readonly mtimeMs?: number;
    readonly size?: number;
}

function isRawFileStat(data: unknown): data is RawFileStat {
    if (typeof data !== 'object' || data === null) {
        return false;
    }
    const d = data as Record<string, unknown>;
    return typeof d.isFile === 'boolean' && typeof d.isDirectory === 'boolean';
}

interface WatcherChangeNotification {
    readonly subscriptionId: string;
    readonly events: readonly WatchEvent[];
}

function isWatcherChangeNotification(params: unknown): params is WatcherChangeNotification {
    if (typeof params !== 'object' || params === null) {
        return false;
    }
    const p = params as Record<string, unknown>;
    return typeof p.subscriptionId === 'string' && Array.isArray(p.events);
}

interface SystemInfoResult {
    readonly platform: HostPlatform;
    readonly version: string;
    readonly repoRoot: string;
    readonly tempDir?: string;
}

function isSystemInfoResult(data: unknown): data is SystemInfoResult {
    if (typeof data !== 'object' || data === null) {
        return false;
    }
    const d = data as Record<string, unknown>;
    return typeof d.platform === 'string' && typeof d.version === 'string' && typeof d.repoRoot === 'string';
}

declare global {
    interface Window {
        __JJ_VIEW_CONFIG__?: {
            token?: string;
            sidecarToken?: string;
            port?: number;
            repoRoot?: string;
            csrfToken?: string;
        };
    }
}

function isResourceTiming(entry: PerformanceEntry): entry is PerformanceResourceTiming {
    return entry.entryType === 'resource';
}

/**
 * Breaks a PerformanceResourceTiming entry into the phases Chrome's Network
 * panel shows, so a single log line answers: which protocol, was the socket
 * reused, how long did the request sit in the browser queue, and how much of
 * the remaining time was transit vs. daemon work.
 */
function formatResourceTiming(entry: PerformanceResourceTiming): string {
    const connect = entry.connectEnd > 0 ? entry.connectEnd - entry.connectStart : 0;
    const tls = entry.secureConnectionStart > 0 ? entry.connectEnd - entry.secureConnectionStart : 0;
    // Time between fetch() being issued and the request actually leaving the
    // socket, excluding connection setup. This is Chrome's "Stalled" segment and
    // is where connection-pool contention shows up.
    const stall = entry.requestStart > 0 ? entry.requestStart - entry.fetchStart - connect : 0;
    const ttfb = entry.responseStart > 0 ? entry.responseStart - entry.requestStart : 0;
    const download = entry.responseStart > 0 ? entry.responseEnd - entry.responseStart : 0;
    const serverParts = entry.serverTiming.map((st) => `${st.name}=${st.duration.toFixed(2)}ms`);
    const server = serverParts.length > 0 ? serverParts.join(',') : 'n/a';
    const proto = entry.nextHopProtocol || 'unknown';
    const reused = connect === 0 ? 'reused' : 'new';
    return (
        `proto=${proto} socket=${reused} stall=${stall.toFixed(1)}ms connect=${connect.toFixed(1)}ms ` +
        `tls=${tls.toFixed(1)}ms ttfb=${ttfb.toFixed(1)}ms download=${download.toFixed(1)}ms ` +
        `server=[${server}] transfer=${entry.transferSize}B body=${entry.encodedBodySize}B`
    );
}

const RPC_PARAM_SUMMARY_MAX = 120;
const RPC_ARG_MAX = 40;

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function headOf(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, max - 1)}…`;
}

function tailOf(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    return `…${text.slice(text.length - max + 1)}`;
}

/**
 * One-line summary of an RPC's params for perf logs: the argv for process
 * calls, the path for fs/watcher calls, the path count for batched reads.
 * Lets a pasted console log attribute each request to a concrete jj command
 * or file without turning on debug logging.
 */
function describeRpcParams(method: string, params: unknown): string {
    if (typeof params !== 'object' || params === null) {
        return '';
    }
    const record = params as Record<string, unknown>;
    if (method.startsWith('process.')) {
        const file = typeof record.file === 'string' ? record.file.split('/').pop() : '';
        const args = isStringArray(record.args) ? record.args : [];
        const shownArgs: string[] = [];
        for (let i = 0; i < args.length; i++) {
            // `--config k=v` pairs are identical on every jj call; drop them so
            // the subcommand and its revset stay within the clipped summary.
            if (args[i] === '--config') {
                i++;
                continue;
            }
            shownArgs.push(headOf(args[i], RPC_ARG_MAX));
        }
        const argv = [file, ...shownArgs].filter((a) => a !== undefined && a !== '').join(' ');
        // cwd decides what `jj root`/`jj log` resolve to; two spawns with the
        // same argv but different cwds are not duplicates.
        const cwd = typeof record.cwd === 'string' ? ` [cwd ${tailOf(record.cwd, 40)}]` : '';
        return headOf(argv, RPC_PARAM_SUMMARY_MAX) + cwd;
    }
    if (isStringArray(record.paths)) {
        return `${record.paths.length} paths`;
    }
    if (typeof record.path === 'string') {
        return tailOf(record.path, RPC_PARAM_SUMMARY_MAX);
    }
    if (typeof record.key === 'string') {
        return record.key;
    }
    return '';
}

export class RemoteHostSystem implements HostSystem {
    public readonly process: HostProcess;
    public readonly fs: HostFs;
    public readonly watcher: HostWatcher;

    private _platform: HostPlatform;
    private _tempDir: string;
    private _repoRoot: string = '';
    private _version: string = '';

    private readonly _options: RemoteHostSystemOptions;
    private _resolvedToken?: string;
    private readonly _baseUrl: string;
    private _clientId: string;
    private _eventSource: EventSourceLike | null = null;
    private _wsChannel: WsRpcChannel | null = null;
    private _nextRequestId = 1;
    private readonly _activeRequests = new Map<number, AbortController>();
    private readonly _activeSubscriptions = new Map<string, ActiveWatcherSubscription>();
    private readonly _configListeners = new Set<(key: string, scope: string) => void>();
    private readonly _stateListeners = new Set<(key: string) => void>();
    private readonly _secretsListeners = new Set<(key: string) => void>();
    private _isDisposed = false;
    private _reconnectAttempts = 0;
    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private _readyPromise: Promise<void> | null = null;
    private _readyResolve: (() => void) | null = null;
    private _readyReject: ((err: Error) => void) | null = null;
    private _timingObserver: PerformanceObserver | null = null;
    private readonly _pendingTimings = new Map<number, string>();
    private static readonly MAX_PENDING_TIMINGS = 500;

    constructor(options?: RemoteHostSystemOptions) {
        this._options = options ?? {};
        this._platform = this._options.platform ?? 'linux';
        this._tempDir = this._options.tempDir ?? '/tmp';
        this._clientId = this._options.clientId ?? generateRandomId();
        this._baseUrl = this._resolveBaseUrl();

        this.process = new RemoteHostProcess(this);
        this.fs = new RemoteHostFs(this);
        this.watcher = new RemoteHostWatcher(this);

        this._createReadyPromise();
        this._installTimingObserver();

        if (this._options.autoConnect ?? true) {
            this.connect();
        }
    }

    /**
     * Observes PerformanceResourceTiming entries for /api/rpc and logs a
     * per-request breakdown (protocol, socket reuse, browser-side stall, TTFB,
     * download, Server-Timing). This is the only way to tell queueing in the
     * browser's connection pool apart from proxy/network transit; fetch() wall
     * time alone cannot distinguish them.
     *
     * Entries are matched to requests by the `rid` query parameter carried on
     * the RPC URL; resource timing exposes no other handle on the request.
     */
    private _installTimingObserver(): void {
        if (typeof PerformanceObserver === 'undefined') {
            return;
        }
        try {
            const observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (!isResourceTiming(entry)) {
                        continue;
                    }
                    const rid = RemoteHostSystem._parseRequestId(entry.name);
                    if (rid === null) {
                        continue;
                    }
                    this._logResourceTiming(rid, entry);
                }
            });
            observer.observe({ type: 'resource', buffered: false });
            this._timingObserver = observer;
        } catch {
            // Resource timing not supported in this environment; keep the plain
            // fetch() wall-time log only.
        }
    }

    private static readonly RPC_URL_RE = /\/api\/rpc\?rid=(\d+)$/;

    private static _parseRequestId(url: string): number | null {
        const match = RemoteHostSystem.RPC_URL_RE.exec(url);
        if (!match) {
            return null;
        }
        return Number(match[1]);
    }

    private _rpcUrl(id: number): string {
        return `${this._baseUrl}/api/rpc?rid=${id}`;
    }

    private _logResourceTiming(id: number, entry: PerformanceResourceTiming): void {
        const method = this._pendingTimings.get(id);
        if (method === undefined) {
            return;
        }
        this._pendingTimings.delete(id);
        if (typeof console !== 'undefined' && console.log) {
            console.log(
                `[Perf:RPC:net] ${method} (#${id}) total=${entry.duration.toFixed(1)}ms ${formatResourceTiming(entry)}`,
            );
        }
    }

    private _trackPendingTiming(id: number, method: string): void {
        if (!this._timingObserver) {
            return;
        }
        this._pendingTimings.set(id, method);
        if (this._pendingTimings.size <= RemoteHostSystem.MAX_PENDING_TIMINGS) {
            return;
        }
        // Entries whose resource timing never arrived (e.g. aborted requests)
        // would otherwise accumulate; evict the oldest.
        const oldest = this._pendingTimings.keys().next();
        if (!oldest.done) {
            this._pendingTimings.delete(oldest.value);
        }
    }

    public get platform(): HostPlatform {
        return this._platform;
    }

    public get tempDir(): string {
        return this._tempDir;
    }

    public get repoRoot(): string {
        return this._repoRoot;
    }

    public get version(): string {
        return this._version;
    }

    public get ready(): Promise<void> {
        return this._readyPromise ?? Promise.resolve();
    }

    public get isConnected(): boolean {
        return this._eventSource !== null && this._eventSource.readyState === 1; // 1 = OPEN
    }

    private _createReadyPromise(): void {
        this._readyPromise = new Promise<void>((resolve, reject) => {
            this._readyResolve = resolve;
            this._readyReject = reject;
        });
        this._readyPromise.catch(() => {});
    }

    public connect(): void {
        if (this._isDisposed) {
            return;
        }

        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }

        const eventsUrl = this._resolveEventsUrl();
        const factory = this._options.eventSourceFactory ?? this._defaultEventSourceFactory;
        if (!factory) {
            const err = new Error(
                'EventSource is not available in the current environment. Provide eventSourceFactory in RemoteHostSystemOptions.',
            );
            if (this._readyReject) {
                this._readyReject(err);
                this._readyReject = null;
                this._readyResolve = null;
            }
            this._readyPromise = Promise.reject(err);
            this._readyPromise.catch(() => {});
            return;
        }

        try {
            const es = factory(eventsUrl);
            this._eventSource = es;

            es.onopen = () => {
                this._handleOpen();
            };

            es.onmessage = (event) => {
                this._handleMessage(event.data);
            };

            es.onerror = (event) => {
                this._handleError(event);
            };
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (this._readyReject) {
                this._readyReject(error);
                this._readyReject = null;
                this._readyResolve = null;
            }
            this._readyPromise = Promise.reject(error);
            this._readyPromise.catch(() => {});
        }
    }

    private get _defaultEventSourceFactory(): ((url: string) => EventSourceLike) | undefined {
        if (typeof EventSource !== 'undefined') {
            return (url: string) => new EventSource(url, { withCredentials: true });
        }
        return undefined;
    }

    private _resolveBaseUrl(): string {
        if (this._options.url) {
            let u = this._options.url.trim();
            if (u.startsWith('ws://')) {
                u = `http://${u.slice(5)}`;
            } else if (u.startsWith('wss://')) {
                u = `https://${u.slice(6)}`;
            }
            try {
                const parsed = new URL(u);
                const queryToken = parsed.searchParams.get('token') || parsed.searchParams.get('sidecar_token');
                if (queryToken && !this._resolvedToken) {
                    this._resolvedToken = queryToken;
                }
                const prefix = parsed.pathname.replace(/\/(?:ws\/system|api\/(?:rpc|events))$/, '').replace(/\/+$/, '');
                return `${parsed.protocol}//${parsed.host}${prefix}`;
            } catch {
                u = u.replace(/\/(?:ws\/system|api\/(?:rpc|events))(?:\?.*)?$/, '');
                return u.replace(/\/+$/, '');
            }
        }

        let protocol = 'http:';
        let host = '127.0.0.1:8080';

        if (typeof window !== 'undefined') {
            const cfg = window.__JJ_VIEW_CONFIG__;
            if (window.location?.protocol === 'https:') {
                protocol = 'https:';
            }
            if (window.location?.host) {
                host = window.location.host;
            } else if (cfg?.port) {
                host = `127.0.0.1:${cfg.port}`;
            }
        }

        return `${protocol}//${host}`;
    }

    private _resolveToken(): string | undefined {
        if (this._options.token) {
            return this._options.token;
        }
        if (this._resolvedToken) {
            return this._resolvedToken;
        }
        if (typeof window !== 'undefined') {
            const cfg = window.__JJ_VIEW_CONFIG__;
            if (cfg?.sidecarToken) {
                this._resolvedToken = cfg.sidecarToken;
                this._persistToken(cfg.sidecarToken);
                return cfg.sidecarToken;
            }
            if (cfg?.token) {
                this._resolvedToken = cfg.token;
                this._persistToken(cfg.token);
                return cfg.token;
            }
            if (window.location?.search) {
                const params = new URLSearchParams(window.location.search);
                const queryToken = params.get('token') || params.get('sidecar_token');
                if (queryToken) {
                    this._resolvedToken = queryToken;
                    this._persistToken(queryToken);
                    return queryToken;
                }
            }
            if (window.sessionStorage) {
                try {
                    const stored = window.sessionStorage.getItem('jj_view_token');
                    if (stored) {
                        this._resolvedToken = stored;
                        return stored;
                    }
                } catch {
                    // Ignore storage access restrictions
                }
            }
        }
        return undefined;
    }

    private _persistToken(token: string): void {
        if (typeof window !== 'undefined' && window.sessionStorage) {
            try {
                window.sessionStorage.setItem('jj_view_token', token);
            } catch {
                // Ignore storage access restrictions
            }
        }
    }

    private _resolveCsrfToken(): string | undefined {
        if (this._options.csrfToken) {
            return this._options.csrfToken;
        }
        if (typeof window !== 'undefined') {
            return window.__JJ_VIEW_CONFIG__?.csrfToken;
        }
        return undefined;
    }

    private _resolveEventsUrl(): string {
        const token = this._resolveToken();
        const queryParams = new URLSearchParams();
        if (this._clientId) {
            queryParams.set('clientId', this._clientId);
        }
        if (token) {
            queryParams.set('token', token);
        }
        const qs = queryParams.toString();
        return `${this._baseUrl}/api/events${qs ? `?${qs}` : ''}`;
    }

    private _resolveWsUrl(): string {
        const token = this._resolveToken();
        const queryParams = new URLSearchParams();
        if (this._clientId) {
            queryParams.set('clientId', this._clientId);
        }
        if (token) {
            queryParams.set('token', token);
        }
        const qs = queryParams.toString();
        const wsBase = this._baseUrl.replace(/^http/, 'ws');
        return `${wsBase}/api/ws${qs ? `?${qs}` : ''}`;
    }

    private get _defaultWebSocketFactory(): WebSocketFactory | undefined {
        if (typeof WebSocket !== 'undefined') {
            return (url: string): WebSocketLike => new WebSocket(url);
        }
        return undefined;
    }

    /**
     * Opens the WebSocket RPC channel if configured and not already open.
     * Called after `system.info` succeeds over HTTP so (a) the daemon is known
     * reachable and (b) the browser has a primed connection with the right
     * TLS SNI before the upgrade (see the 421 handling in the daemon's handleWS).
     */
    private _ensureWebSocket(): void {
        if (this._isDisposed || this._wsChannel || (this._options.useWebSocket ?? true) === false) {
            return;
        }
        const factory = this._options.webSocketFactory ?? this._defaultWebSocketFactory;
        if (!factory) {
            return;
        }
        this._wsChannel = new WsRpcChannel({
            url: this._resolveWsUrl(),
            factory,
            reconnectDelayMs: this._options.reconnectDelayMs,
            maxReconnectAttempts: this._options.reconnect === false ? 0 : this._options.maxReconnectAttempts,
            onNotification: (method, params) => this._handleNotification(method, params),
            log: (message) => {
                if (typeof console !== 'undefined' && console.log) {
                    console.log(message);
                }
            },
        });
        this._wsChannel.connect();
    }

    private _handleOpen(): void {
        this._reconnectAttempts = 0;

        // Query system info to populate platform, version, repoRoot, and tempDir
        this._sendRequest<unknown>('system.info')
            .then((info) => {
                if (isSystemInfoResult(info)) {
                    this._platform = info.platform;
                    this._version = info.version;
                    this._repoRoot = info.repoRoot;
                    if (info.tempDir) {
                        this._tempDir = info.tempDir;
                    }
                }
                this._ensureWebSocket();
                this._reconnectWatchers();
                if (this._readyResolve) {
                    this._readyResolve();
                    this._readyResolve = null;
                    this._readyReject = null;
                }
            })
            .catch((err) => {
                const error = err instanceof Error ? err : new Error(String(err));
                if (this._readyReject) {
                    this._readyReject(error);
                    this._readyReject = null;
                    this._readyResolve = null;
                }
                this._readyPromise = Promise.reject(error);
                this._readyPromise.catch(() => {});
            });
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

        const msg = parsed as Record<string, unknown>;

        // Handle notifications (no id)
        if (msg.id === undefined && typeof msg.method === 'string') {
            this._handleNotification(msg.method, msg.params);
        }
    }

    private _handleNotification(method: string, params: unknown): void {
        if (method === 'system.connected') {
            if (
                params &&
                typeof params === 'object' &&
                'clientId' in params &&
                typeof (params as { clientId?: unknown }).clientId === 'string'
            ) {
                this._clientId = (params as { clientId: string }).clientId;
            }
            return;
        }

        if (method === 'config/didChange') {
            const key =
                params &&
                typeof params === 'object' &&
                'key' in params &&
                typeof (params as { key?: unknown }).key === 'string'
                    ? (params as { key: string }).key
                    : '';
            const scope =
                params &&
                typeof params === 'object' &&
                'scope' in params &&
                typeof (params as { scope?: unknown }).scope === 'string'
                    ? (params as { scope: string }).scope
                    : 'workspace';
            for (const listener of this._configListeners) {
                try {
                    listener(key, scope);
                } catch {
                    // Ignore listener errors
                }
            }
            return;
        }

        if (method === 'state/didChange') {
            if (!params || typeof params !== 'object' || !('key' in params)) {
                return;
            }
            const key = (params as { key?: unknown }).key;
            if (typeof key !== 'string' || key.length === 0) {
                return;
            }
            for (const listener of this._stateListeners) {
                try {
                    listener(key);
                } catch {
                    // Ignore listener errors
                }
            }
            return;
        }

        if (method === 'secrets/didChange') {
            if (!params || typeof params !== 'object' || !('key' in params)) {
                return;
            }
            const key = (params as { key?: unknown }).key;
            if (typeof key !== 'string' || key.length === 0) {
                return;
            }
            for (const listener of this._secretsListeners) {
                try {
                    listener(key);
                } catch {
                    // Ignore listener errors
                }
            }
            return;
        }

        if (method !== 'watcher.change') {
            return;
        }
        if (!isWatcherChangeNotification(params)) {
            return;
        }
        const sub = this._activeSubscriptions.get(params.subscriptionId);
        if (!sub) {
            return;
        }
        sub.callback(null, [...params.events]);
    }

    private _handleError(_event: unknown): void {
        if (this._isDisposed) {
            return;
        }

        if (!this._eventSource || this._eventSource.readyState === 2) {
            this._handleDisconnect();
        }
    }

    private _handleDisconnect(): void {
        if (this._isDisposed) {
            return;
        }

        const es = this._eventSource;
        this._eventSource = null;
        if (es && es.readyState !== 2) {
            try {
                es.close();
            } catch {
                // Ignore close error
            }
        }

        const shouldReconnect = this._options.reconnect ?? true;
        const maxAttempts = this._options.maxReconnectAttempts ?? 10;
        if (!shouldReconnect || this._reconnectAttempts >= maxAttempts) {
            const err = new Error('SSE connection closed and reconnection stopped');
            if (this._readyReject) {
                this._readyReject(err);
                this._readyReject = null;
                this._readyResolve = null;
            }
            this._readyPromise = Promise.reject(err);
            this._readyPromise.catch(() => {});
            return;
        }

        this._createReadyPromise();
        this._reconnectAttempts++;
        const delay = (this._options.reconnectDelayMs ?? 1000) * Math.min(this._reconnectAttempts, 5);
        this._reconnectTimer = setTimeout(() => {
            this.connect();
        }, delay);
    }

    private async _reconnectWatchers(): Promise<void> {
        for (const [oldSubId, sub] of Array.from(this._activeSubscriptions.entries())) {
            try {
                const res = await this._sendRequest<{ subscriptionId: string }>('watcher.watch', {
                    dirPath: sub.dirPath,
                    ignore: sub.options?.ignore,
                });
                if (!this._activeSubscriptions.has(oldSubId)) {
                    // Unsubscribed while reconnection was in flight
                    this.notify('watcher.unwatch', { subscriptionId: res.subscriptionId });
                    continue;
                }
                this._activeSubscriptions.delete(oldSubId);
                sub.subscriptionId = res.subscriptionId;
                this._activeSubscriptions.set(res.subscriptionId, sub);
            } catch {
                // Ignore watcher re-subscribe error on reconnect
            }
        }
    }

    public async request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
        if (this._isDisposed) {
            throw new Error('RemoteHostSystem is disposed');
        }

        if (signal?.aborted) {
            throw new Error('Request aborted');
        }

        await this.ready;
        return this._sendRequest<T>(method, params, signal);
    }

    private async _sendRequest<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
        if (this._isDisposed) {
            throw new Error('RemoteHostSystem is disposed');
        }

        if (signal?.aborted) {
            throw new Error('Request aborted');
        }

        if (!this.isConnected) {
            throw new Error('Host daemon is not connected');
        }

        const id = this._nextRequestId++;
        const requestPayload: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };

        const timeoutMs = this._options.requestTimeoutMs ?? 60000;
        const abortController = new AbortController();
        this._activeRequests.set(id, abortController);

        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let didTimeout = false;

        if (timeoutMs > 0) {
            timeoutTimer = setTimeout(() => {
                didTimeout = true;
                this.notify('$/cancelRequest', { id });
                abortController.abort(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }

        let abortListener: (() => void) | undefined;
        if (signal) {
            abortListener = () => {
                this.notify('$/cancelRequest', { id });
                abortController.abort(signal.reason ?? new Error('Request aborted'));
            };
            signal.addEventListener('abort', abortListener, { once: true });
        }

        const startTime = performance.now();

        try {
            const frame = JSON.stringify(requestPayload);
            const transport = this._wsChannel?.isOpen
                ? this._wsTransport(id, method, frame, abortController.signal)
                : this._httpTransport(id, method, frame, abortController.signal);
            const { response, via, netDuration } = await transport;
            const totalDuration = performance.now() - startTime;
            if (typeof console !== 'undefined' && console.log) {
                const summary = describeRpcParams(method, params);
                console.log(
                    `[Perf:RPC] ${method} (#${id}) completed in ${totalDuration.toFixed(1)}ms (net: ${netDuration.toFixed(1)}ms, via: ${via}) start=+${startTime.toFixed(0)}ms${summary ? ` :: ${summary}` : ''}`,
                );
            }
            if (response.error) {
                const errData = response.error.data;
                if (response.error.code === RPC_CODE_PROCESS_ERROR && isProcessExitData(errData)) {
                    throw new ProcessExitError(
                        response.error.message,
                        errData.exitCode,
                        errData.stdout,
                        errData.stderr,
                    );
                }

                const isEnoent =
                    response.error.message.startsWith('ENOENT') ||
                    (typeof errData === 'object' &&
                        errData !== null &&
                        (errData as { code?: string }).code === 'ENOENT');

                if (isEnoent) {
                    throw new HostSystemError(response.error.message, 'ENOENT');
                }

                throw new Error(response.error.message);
            }

            return response.result as T;
        } catch (err) {
            if (didTimeout) {
                throw new Error(`Request ${method} timed out after ${timeoutMs}ms`);
            }
            if (signal?.aborted) {
                throw new Error('Request aborted');
            }
            if (err instanceof Error) {
                throw err;
            }
            throw new Error(String(err));
        } finally {
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
            }
            if (signal && abortListener) {
                signal.removeEventListener('abort', abortListener);
            }
            this._activeRequests.delete(id);
        }
    }

    public notify(method: string, params?: unknown): void {
        if (this._isDisposed) {
            return;
        }

        const notification: JsonRpcNotification = {
            jsonrpc: '2.0',
            method,
            params,
        };
        const frame = JSON.stringify(notification);

        if (this._wsChannel?.notify(frame)) {
            return;
        }

        const fetchFn = this._options.fetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
        if (!fetchFn) {
            return;
        }

        fetchFn(`${this._baseUrl}/api/rpc`, {
            method: 'POST',
            headers: this._rpcHeaders(),
            body: frame,
            credentials: 'include',
        }).catch(() => {
            // Notifications are best-effort
        });
    }

    private _rpcHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (this._clientId) {
            headers['X-Client-ID'] = this._clientId;
        }
        const token = this._resolveToken();
        if (token) {
            headers['X-Sidecar-Token'] = token;
            headers.Authorization = `Bearer ${token}`;
        }
        const csrfToken = this._resolveCsrfToken();
        if (csrfToken) {
            headers['X-CSRF-Token'] = csrfToken;
        }
        return headers;
    }

    private async _wsTransport(
        id: number,
        method: string,
        frame: string,
        signal: AbortSignal,
    ): Promise<{ response: JsonRpcResponse; via: 'ws'; netDuration: number }> {
        const channel = this._wsChannel;
        if (!channel) {
            throw new WsTransportError('WebSocket channel unavailable');
        }
        const start = performance.now();
        const response = await channel.request(id, method, frame, signal);
        return { response, via: 'ws', netDuration: performance.now() - start };
    }

    private async _httpTransport(
        id: number,
        method: string,
        frame: string,
        signal: AbortSignal,
    ): Promise<{ response: JsonRpcResponse; via: 'http'; netDuration: number }> {
        const fetchFn = this._options.fetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
        if (!fetchFn) {
            throw new Error(
                'Fetch is not available in the current environment. Provide fetch in RemoteHostSystemOptions.',
            );
        }

        const fetchStart = performance.now();
        this._trackPendingTiming(id, method);
        const resp = await fetchFn(this._rpcUrl(id), {
            method: 'POST',
            headers: this._rpcHeaders(),
            body: frame,
            signal,
            credentials: 'include',
        });
        const netDuration = performance.now() - fetchStart;

        if (!resp.ok) {
            if (resp.status === 401) {
                throw new HostSystemError('Unauthorized', 'EACCES');
            }
            if (resp.status === 403) {
                throw new Error('Forbidden');
            }
            const errorText = await resp.text().catch(() => '');
            throw new Error(`HTTP error ${resp.status}: ${errorText || resp.statusText}`);
        }

        const response = (await resp.json()) as JsonRpcResponse;
        return { response, via: 'http', netDuration };
    }

    public registerWatcherSubscription(sub: ActiveWatcherSubscription): void {
        this._activeSubscriptions.set(sub.subscriptionId, sub);
    }

    public unregisterWatcherSubscription(subscriptionId: string): void {
        this._activeSubscriptions.delete(subscriptionId);
    }

    public onConfigDidChange(listener: (key: string, scope: string) => void): { dispose: () => void } {
        this._configListeners.add(listener);
        return {
            dispose: () => {
                this._configListeners.delete(listener);
            },
        };
    }

    public async getConfig<T = unknown>(
        key: string,
        scope?: 'effective' | 'user' | 'workspace',
    ): Promise<T | undefined> {
        const res = await this.request<{ value: T; found: boolean }>('config.get', { key, scope });
        return res.found ? res.value : undefined;
    }

    public async setConfig(key: string, value: unknown, scope?: 'user' | 'workspace'): Promise<void> {
        await this.request<{ success: boolean }>('config.set', { key, value, scope });
    }

    public async getAllConfig(scope?: 'effective' | 'user' | 'workspace'): Promise<Record<string, unknown>> {
        return this.request<Record<string, unknown>>('config.getAll', { scope });
    }

    public onStateDidChange(listener: (key: string) => void): { dispose: () => void } {
        this._stateListeners.add(listener);
        return {
            dispose: () => {
                this._stateListeners.delete(listener);
            },
        };
    }

    public onSecretsDidChange(listener: (key: string) => void): { dispose: () => void } {
        this._secretsListeners.add(listener);
        return {
            dispose: () => {
                this._secretsListeners.delete(listener);
            },
        };
    }

    public onSecretDidChange(listener: (key: string) => void): { dispose: () => void } {
        return this.onSecretsDidChange(listener);
    }

    public async getState<T = unknown>(key: string): Promise<T | undefined> {
        const res = await this.request<{ value?: T; found: boolean }>('state.get', { key });
        return res.found ? (res.value as T) : undefined;
    }

    public async setState(key: string, value: unknown): Promise<void> {
        await this.request<{ success: boolean }>('state.set', { key, value });
    }

    public async deleteState(key: string): Promise<void> {
        await this.request<{ success: boolean }>('state.delete', { key });
    }

    public async getAllState(): Promise<Record<string, unknown>> {
        return this.request<Record<string, unknown>>('state.getAll');
    }

    public async getSecret(key: string): Promise<string | undefined> {
        const res = await this.request<{ value?: string; found: boolean }>('secrets.get', { key });
        return res.found ? res.value : undefined;
    }

    public async storeSecret(key: string, value: string): Promise<void> {
        await this.request<{ success: boolean }>('secrets.store', { key, value });
    }

    public async deleteSecret(key: string): Promise<void> {
        await this.request<{ success: boolean }>('secrets.delete', { key });
    }

    public async findFiles(
        pattern: string,
        baseDir?: string,
        maxResults?: number,
        excludes?: string[],
    ): Promise<string[]> {
        const res = await this.request<{ files: string[] }>('fs.findFiles', {
            baseDir: baseDir ?? this.repoRoot,
            pattern,
            maxResults,
            excludes,
        });
        return res.files ?? [];
    }

    public dispose(): void {
        if (this._isDisposed) {
            return;
        }
        this._isDisposed = true;
        this._configListeners.clear();
        this._stateListeners.clear();
        this._secretsListeners.clear();

        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }

        if (this._timingObserver) {
            this._timingObserver.disconnect();
            this._timingObserver = null;
        }
        this._pendingTimings.clear();

        if (this._wsChannel) {
            this._wsChannel.dispose();
            this._wsChannel = null;
        }

        const disposeError = new Error('RemoteHostSystem is disposed');
        if (this._readyReject) {
            this._readyReject(disposeError);
            this._readyReject = null;
            this._readyResolve = null;
        }
        this._readyPromise = Promise.reject(disposeError);
        this._readyPromise.catch(() => {});

        for (const ac of this._activeRequests.values()) {
            ac.abort(disposeError);
        }
        this._activeRequests.clear();
        this._activeSubscriptions.clear();

        if (this._eventSource) {
            try {
                this._eventSource.close();
            } catch {
                // Ignore close error
            }
            this._eventSource = null;
        }
    }
}

class RemoteHostProcess implements HostProcess {
    constructor(private readonly _host: RemoteHostSystem) {}

    private _createAbortController(options?: ProcessExecOptions): AbortController {
        const abortController = new AbortController();
        let isKilled = false;

        if (options?.signal) {
            if (options.signal.aborted) {
                abortController.abort();
            } else {
                options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
            }
        }

        if (options?.onSpawn) {
            const proc: TrackableProcess = {
                get killed() {
                    return isKilled || abortController.signal.aborted;
                },
                kill: (_signal?: string | number) => {
                    isKilled = true;
                    abortController.abort();
                    return true;
                },
            };
            options.onSpawn(proc);
        }
        return abortController;
    }

    async execFile(file: string, args: readonly string[], options?: ProcessExecOptions): Promise<ProcessResult> {
        const abortController = this._createAbortController(options);

        const params = {
            file,
            args: [...args],
            cwd: options?.cwd,
            env: options?.env,
            timeout: options?.timeout,
            maxBuffer: options?.maxBuffer,
        };

        const res = await this._host.request<ProcessResult>('process.execFile', params, abortController.signal);
        return {
            stdout: res.stdout ?? '',
            stderr: res.stderr ?? '',
            exitCode: res.exitCode ?? 0,
        };
    }

    async execFileInScratchDir(request: ScratchExecRequest): Promise<ScratchExecResult> {
        const options = request.options;
        const abortController = this._createAbortController(options);

        const params = {
            file: request.file,
            args: [...request.args],
            scratchPrefix: request.scratchPrefix,
            subdirs: [...request.subdirs],
            helperScript: request.helperScript,
            completionMarker: request.completionMarker,
            cwd: options?.cwd,
            env: options?.env,
            timeout: options?.timeout,
            maxBuffer: options?.maxBuffer,
        };

        const res = await this._host.request<ScratchExecResult>(
            'process.execFileInScratchDir',
            params,
            abortController.signal,
        );
        return {
            scratchDir: res.scratchDir,
            markerPresent: res.markerPresent ?? false,
            stdout: res.stdout ?? '',
            stderr: res.stderr ?? '',
            exitCode: res.exitCode ?? 0,
        };
    }

    async getHelperScriptPath(scriptName: HelperScriptName): Promise<string> {
        const res = await this._host.request<{ path: string }>('process.getHelperScriptPath', {
            name: scriptName,
        });
        return res.path;
    }
}

interface PendingRead {
    readonly path: string;
    readonly resolve: (bytes: Uint8Array) => void;
    readonly reject: (err: Error) => void;
}

interface RemoteReadFileEntry {
    readonly content?: string;
    readonly error?: { readonly code?: string; readonly message: string };
}

class RemoteHostFs implements HostFs {
    private _pendingReads: PendingRead[] = [];
    private _readFlushScheduled = false;

    constructor(private readonly _host: RemoteHostSystem) {}

    get tempDir(): string {
        return this._host.tempDir;
    }

    /**
     * Queues a file read. All reads enqueued synchronously within the same microtask
     * are sent to the daemon as one `fs.readFiles` RPC; results and errors are
     * delivered per path, so callers are unaware of the coalescing.
     */
    private _enqueueRead(filePath: string): Promise<Uint8Array> {
        return new Promise<Uint8Array>((resolve, reject) => {
            this._pendingReads.push({ path: filePath, resolve, reject });
            if (this._readFlushScheduled) {
                return;
            }
            this._readFlushScheduled = true;
            queueMicrotask(() => void this._flushReads());
        });
    }

    private async _flushReads(): Promise<void> {
        const batch = this._pendingReads;
        this._pendingReads = [];
        this._readFlushScheduled = false;
        if (batch.length === 0) {
            return;
        }

        const start = performance.now();
        let entries: RemoteReadFileEntry[];
        try {
            const res = await this._host.request<{ files?: RemoteReadFileEntry[] }>('fs.readFiles', {
                paths: batch.map((p) => p.path),
            });
            entries = res.files ?? [];
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            for (const pending of batch) {
                pending.reject(error);
            }
            return;
        }
        const rpcDuration = performance.now() - start;

        let totalBytes = 0;
        batch.forEach((pending, i) => {
            const entry = entries[i];
            if (!entry) {
                pending.reject(new Error(`fs.readFiles: missing result for ${pending.path}`));
                return;
            }
            if (entry.error) {
                const message = entry.error.message;
                pending.reject(
                    entry.error.code === 'ENOENT' ? new HostSystemError(message, 'ENOENT') : new Error(message),
                );
                return;
            }
            const bytes = base64ToUint8Array(entry.content ?? '');
            totalBytes += bytes.length;
            pending.resolve(bytes);
        });

        if (typeof console !== 'undefined' && console.log) {
            const totalDuration = performance.now() - start;
            console.log(
                `[Perf:RemoteFs] readFiles(${batch.length} paths) took ${totalDuration.toFixed(1)}ms (rpc: ${rpcDuration.toFixed(1)}ms, size: ${totalBytes} bytes)`,
            );
        }
    }

    async readTextFiles(paths: readonly string[]): Promise<(string | null)[]> {
        const decoder = new TextDecoder('utf-8');
        return Promise.all(
            paths.map(async (filePath) => {
                try {
                    return decoder.decode(await this._enqueueRead(filePath));
                } catch (err) {
                    if (err instanceof HostSystemError && err.code === 'ENOENT') {
                        return null;
                    }
                    throw err;
                }
            }),
        );
    }

    async readTextFile(filePath: string): Promise<string> {
        const bytes = await this._enqueueRead(filePath);
        return new TextDecoder('utf-8').decode(bytes);
    }

    async readBinaryFile(filePath: string): Promise<Uint8Array> {
        return this._enqueueRead(filePath);
    }

    async writeTextFile(filePath: string, content: string): Promise<void> {
        const bytes = new TextEncoder().encode(content);
        const base64 = uint8ArrayToBase64(bytes);
        await this._host.request<{ success: boolean }>('fs.writeFile', {
            path: filePath,
            content: base64,
        });
    }

    async writeBinaryFile(filePath: string, content: Uint8Array): Promise<void> {
        const base64 = uint8ArrayToBase64(content);
        await this._host.request<{ success: boolean }>('fs.writeFile', {
            path: filePath,
            content: base64,
        });
    }

    async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
        await this._host.request<{ success: boolean }>('fs.mkdir', {
            path: dirPath,
            recursive: options?.recursive ?? false,
        });
    }

    async stat(targetPath: string): Promise<FileStat> {
        const res = await this._host.request<unknown>('fs.stat', { path: targetPath });
        const raw = isRawFileStat(res) ? res : { isFile: false, isDirectory: false, isSymbolicLink: false };
        return {
            isFile: () => raw.isFile,
            isDirectory: () => raw.isDirectory,
            isSymbolicLink: () => raw.isSymbolicLink ?? false,
            mtimeMs: raw.mtimeMs,
            size: raw.size,
        };
    }

    async lstat(targetPath: string): Promise<FileStat> {
        const res = await this._host.request<unknown>('fs.lstat', { path: targetPath });
        const raw = isRawFileStat(res) ? res : { isFile: false, isDirectory: false, isSymbolicLink: false };
        return {
            isFile: () => raw.isFile,
            isDirectory: () => raw.isDirectory,
            isSymbolicLink: () => raw.isSymbolicLink ?? false,
            mtimeMs: raw.mtimeMs,
            size: raw.size,
        };
    }

    async readdir(dirPath: string): Promise<string[]> {
        const res = await this._host.request<{ files: string[] }>('fs.readdir', { path: dirPath });
        return res.files ?? [];
    }

    async exists(targetPath: string): Promise<boolean> {
        const res = await this._host.request<{ exists: boolean }>('fs.exists', { path: targetPath });
        return res.exists ?? false;
    }

    private readonly _realpathCache = new Map<string, Promise<string>>();

    clearRealpathCache(): void {
        this._realpathCache.clear();
    }

    async realpath(targetPath: string): Promise<string> {
        let promise = this._realpathCache.get(targetPath);
        if (promise) {
            return promise;
        }
        promise = (async () => {
            try {
                const res = await this._host.request<{ resolvedPath: string }>('fs.realpath', {
                    path: targetPath,
                });
                return res.resolvedPath;
            } catch (err) {
                this._realpathCache.delete(targetPath);
                throw err;
            }
        })();
        this._realpathCache.set(targetPath, promise);
        return promise;
    }

    async mkdtemp(prefix: string): Promise<string> {
        const res = await this._host.request<{ path: string }>('fs.mkdtemp', { prefix });
        return res.path;
    }

    async rm(targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
        await this._host.request<{ success: boolean }>('fs.rm', {
            path: targetPath,
            recursive: options?.recursive ?? false,
            force: options?.force ?? false,
        });
    }

    async unlink(targetPath: string): Promise<void> {
        await this.rm(targetPath, { recursive: false, force: true });
    }
}

class RemoteHostWatcher implements HostWatcher {
    constructor(private readonly _host: RemoteHostSystem) {}

    async watch(
        dirPath: string,
        callback: (err: Error | null, events: WatchEvent[]) => void,
        options?: WatchOptions,
    ): Promise<WatcherSubscription> {
        const res = await this._host.request<{ subscriptionId: string }>('watcher.watch', {
            dirPath,
            ignore: options?.ignore,
        });

        const sub: ActiveWatcherSubscription = {
            dirPath,
            options,
            callback,
            subscriptionId: res.subscriptionId,
        };

        this._host.registerWatcherSubscription(sub);

        let unsubscribed = false;
        return {
            unsubscribe: async () => {
                if (unsubscribed) {
                    return;
                }
                unsubscribed = true;
                const currentSubId = sub.subscriptionId;
                this._host.unregisterWatcherSubscription(currentSubId);
                try {
                    await this._host.request<{ success: boolean }>('watcher.unwatch', {
                        subscriptionId: currentSubId,
                    });
                } catch {
                    // Ignore unwatch errors during disposal
                }
            },
        };
    }
}
