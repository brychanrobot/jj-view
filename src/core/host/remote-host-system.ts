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
    type TrackableProcess,
    type WatchEvent,
    type WatcherSubscription,
    type WatchOptions,
} from './host-system';

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

export interface WebSocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((ev: Event) => void) | null;
    onmessage: ((ev: MessageEvent) => void) | null;
    onerror: ((ev: Event) => void) | null;
    onclose: ((ev: CloseEvent) => void) | null;
}

export interface RemoteHostSystemOptions {
    readonly url?: string;
    readonly token?: string;
    readonly platform?: HostPlatform;
    readonly tempDir?: string;
    readonly webSocketFactory?: (url: string) => WebSocketLike;
    readonly autoConnect?: boolean;
    readonly reconnect?: boolean;
    readonly reconnectDelayMs?: number;
    readonly maxReconnectAttempts?: number;
    readonly requestTimeoutMs?: number;
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

interface PendingRequest {
    readonly id: number;
    readonly method: string;
    readonly resolve: (result: unknown) => void;
    readonly reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
    abortCleanup?: () => void;
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
            port?: number;
            repoRoot?: string;
        };
    }
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
    private _ws: WebSocketLike | null = null;
    private _nextRequestId = 1;
    private readonly _pendingRequests = new Map<number, PendingRequest>();
    private readonly _activeSubscriptions = new Map<string, ActiveWatcherSubscription>();
    private readonly _configListeners = new Set<(key: string, scope: string) => void>();
    private _isDisposed = false;
    private _reconnectAttempts = 0;
    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private _readyPromise: Promise<void> | null = null;
    private _readyResolve: (() => void) | null = null;
    private _readyReject: ((err: Error) => void) | null = null;

    constructor(options?: RemoteHostSystemOptions) {
        this._options = options ?? {};
        this._platform = this._options.platform ?? 'linux';
        this._tempDir = this._options.tempDir ?? '/tmp';

        this.process = new RemoteHostProcess(this);
        this.fs = new RemoteHostFs(this);
        this.watcher = new RemoteHostWatcher(this);

        this._createReadyPromise();

        if (this._options.autoConnect ?? true) {
            this.connect();
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
        return this._ws !== null && this._ws.readyState === 1; // 1 = OPEN
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

        const url = this._resolveWebSocketUrl();
        const factory = this._options.webSocketFactory ?? this._defaultWebSocketFactory;
        if (!factory) {
            const err = new Error(
                'WebSocket is not available in the current environment. Provide webSocketFactory in RemoteHostSystemOptions.',
            );
            if (this._readyReject) {
                this._readyReject(err);
                this._readyReject = null;
                this._readyResolve = null;
            }
            return;
        }

        try {
            const ws = factory(url);
            this._ws = ws;

            ws.onopen = () => {
                this._handleOpen();
            };

            ws.onmessage = (event) => {
                this._handleMessage(event.data);
            };

            ws.onerror = (event) => {
                this._handleError(event);
            };

            ws.onclose = (event) => {
                this._handleClose(event.code, event.reason);
            };
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (this._readyReject) {
                this._readyReject(error);
                this._readyReject = null;
                this._readyResolve = null;
            }
            this._rejectPendingRequests(error);
            this._handleError(err);
        }
    }

    private get _defaultWebSocketFactory(): ((url: string) => WebSocketLike) | undefined {
        if (typeof WebSocket !== 'undefined') {
            return (url: string) => new WebSocket(url);
        }
        return undefined;
    }

    private _resolveWebSocketUrl(): string {
        if (this._options.url) {
            return this._options.url;
        }

        let token = this._resolvedToken ?? this._options.token;
        let host = '127.0.0.1:8080';
        let protocol = 'ws:';

        if (typeof window !== 'undefined') {
            const cfg = window.__JJ_VIEW_CONFIG__;
            if (!token && cfg?.token) {
                token = cfg.token;
            }
            if (!token && window.location?.search) {
                const params = new URLSearchParams(window.location.search);
                const queryToken = params.get('token');
                if (queryToken) {
                    token = queryToken;
                    this._resolvedToken = queryToken;
                }
            }
            if (window.location?.protocol === 'https:') {
                protocol = 'wss:';
            }
            if (window.location?.host) {
                host = window.location.host;
            } else if (cfg?.port) {
                host = `127.0.0.1:${cfg.port}`;
            }
        }

        const query = token ? `?token=${encodeURIComponent(token)}` : '';
        return `${protocol}//${host}/ws/system${query}`;
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
            return;
        }

        // Handle response with id
        if (typeof msg.id !== 'number' && typeof msg.id !== 'string') {
            return;
        }

        const idNum = typeof msg.id === 'number' ? msg.id : Number.parseInt(msg.id, 10);
        const pending = this._pendingRequests.get(idNum);
        if (!pending) {
            return;
        }

        this._pendingRequests.delete(idNum);
        if (pending.timer) {
            clearTimeout(pending.timer);
        }
        pending.abortCleanup?.();

        const response = parsed as JsonRpcResponse;
        if (response.error) {
            const errData = response.error.data;
            if (response.error.code === RPC_CODE_PROCESS_ERROR && isProcessExitData(errData)) {
                pending.reject(
                    new ProcessExitError(response.error.message, errData.exitCode, errData.stdout, errData.stderr),
                );
                return;
            }

            const isEnoent =
                response.error.message.startsWith('ENOENT') ||
                (typeof errData === 'object' && errData !== null && (errData as { code?: string }).code === 'ENOENT');

            if (isEnoent) {
                pending.reject(new HostSystemError(response.error.message, 'ENOENT'));
                return;
            }

            pending.reject(new Error(response.error.message));
            return;
        }

        pending.resolve(response.result);
    }

    private _handleNotification(method: string, params: unknown): void {
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
        // Errors are usually followed by close events
    }

    private _rejectPendingRequests(err: Error): void {
        for (const req of this._pendingRequests.values()) {
            if (req.timer) {
                clearTimeout(req.timer);
            }
            req.abortCleanup?.();
            req.reject(err);
        }
        this._pendingRequests.clear();
    }

    private _handleClose(_code: number, _reason: string): void {
        this._ws = null;

        // Reject all pending requests
        this._rejectPendingRequests(new Error('WebSocket connection closed'));

        if (this._isDisposed) {
            return;
        }

        const shouldReconnect = this._options.reconnect ?? true;
        const maxAttempts = this._options.maxReconnectAttempts ?? 10;
        if (!shouldReconnect || this._reconnectAttempts >= maxAttempts) {
            const err = new Error('WebSocket connection closed and reconnection stopped');
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

        if (!this.isConnected || !this._ws) {
            throw new Error('WebSocket is not connected');
        }

        const id = this._nextRequestId++;
        const requestPayload: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };

        return new Promise<T>((resolve, reject) => {
            const timeoutMs = this._options.requestTimeoutMs ?? 60000;
            let abortCleanup: (() => void) | undefined;

            const timer = setTimeout(() => {
                this._pendingRequests.delete(id);
                abortCleanup?.();
                this.notify('$/cancelRequest', { id });
                reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            if (signal) {
                const onAbort = () => {
                    this._pendingRequests.delete(id);
                    clearTimeout(timer);
                    abortCleanup?.();
                    this.notify('$/cancelRequest', { id });
                    reject(new Error('Request aborted'));
                };
                signal.addEventListener('abort', onAbort, { once: true });
                abortCleanup = () => {
                    signal.removeEventListener('abort', onAbort);
                };
            }

            this._pendingRequests.set(id, {
                id,
                method,
                resolve: resolve as (result: unknown) => void,
                reject,
                timer,
                abortCleanup,
            });

            this._ws?.send(JSON.stringify(requestPayload));
        });
    }

    public notify(method: string, params?: unknown): void {
        if (!this.isConnected || !this._ws) {
            return;
        }

        const notification: JsonRpcNotification = {
            jsonrpc: '2.0',
            method,
            params,
        };

        try {
            this._ws.send(JSON.stringify(notification));
        } catch {
            // Notifications are best-effort
        }
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

    public dispose(): void {
        if (this._isDisposed) {
            return;
        }
        this._isDisposed = true;
        this._configListeners.clear();

        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }

        const disposeError = new Error('RemoteHostSystem is disposed');
        if (this._readyReject) {
            this._readyReject(disposeError);
            this._readyReject = null;
            this._readyResolve = null;
        }
        this._readyPromise = Promise.reject(disposeError);
        this._readyPromise.catch(() => {});

        for (const req of this._pendingRequests.values()) {
            if (req.timer) {
                clearTimeout(req.timer);
            }
            req.abortCleanup?.();
            req.reject(disposeError);
        }
        this._pendingRequests.clear();
        this._activeSubscriptions.clear();

        if (this._ws) {
            try {
                this._ws.close(1000, 'Normal Closure');
            } catch {
                // Ignore close error
            }
            this._ws = null;
        }
    }
}

class RemoteHostProcess implements HostProcess {
    constructor(private readonly _host: RemoteHostSystem) {}

    async execFile(file: string, args: readonly string[], options?: ProcessExecOptions): Promise<ProcessResult> {
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

    async getHelperScriptPath(scriptName: HelperScriptName): Promise<string> {
        const res = await this._host.request<{ path: string }>('process.getHelperScriptPath', {
            name: scriptName,
        });
        return res.path;
    }
}

class RemoteHostFs implements HostFs {
    constructor(private readonly _host: RemoteHostSystem) {}

    get tempDir(): string {
        return this._host.tempDir;
    }

    async readTextFile(filePath: string): Promise<string> {
        const res = await this._host.request<{ content: string }>('fs.readFile', { path: filePath });
        const bytes = base64ToUint8Array(res.content);
        return new TextDecoder('utf-8').decode(bytes);
    }

    async readBinaryFile(filePath: string): Promise<Uint8Array> {
        const res = await this._host.request<{ content: string }>('fs.readFile', { path: filePath });
        return base64ToUint8Array(res.content);
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

    async realpath(targetPath: string): Promise<string> {
        const res = await this._host.request<{ resolvedPath: string }>('fs.realpath', {
            path: targetPath,
        });
        return res.resolvedPath;
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
