/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ProcessExitError, type TrackableProcess } from '../core/host/host-system';
import {
    type EventSourceLike,
    HostSystemError,
    RemoteHostSystem,
    RPC_CODE_INTERNAL_ERROR,
    RPC_CODE_PROCESS_ERROR,
} from '../core/host/remote-host-system';
import { type WebSocketLike, WsTransportError } from '../core/host/ws-rpc-channel';

class FakeDaemonTransport implements EventSourceLike {
    public readyState: number = 0; // 0 = CONNECTING, 1 = OPEN, 2 = CLOSED
    public sentMessages: string[] = [];
    public readonly fetchBodies: string[] = [];
    public onopen: ((ev: Event) => void) | null = null;
    public onmessage: ((ev: MessageEvent) => void) | null = null;
    public onerror: ((ev: Event) => void) | null = null;

    private readonly _messageHandlers: Array<(msg: Record<string, unknown>) => void> = [];
    private readonly _pendingRpc = new Map<number | string, (resp: Response) => void>();

    constructor() {
        this.fetch = this.fetch.bind(this);
    }

    send(data: string): void {
        this.sentMessages.push(data);
        const parsed = JSON.parse(data) as Record<string, unknown>;
        queueMicrotask(() => {
            for (const handler of [...this._messageHandlers]) {
                handler(parsed);
            }
        });
    }

    close(_code?: number, _reason?: string): void {
        if (this.readyState === 2) {
            return;
        }
        this.readyState = 2; // CLOSED
        if (this.onerror) {
            this.onerror(new Event('error'));
        }
    }

    open(): void {
        this.readyState = 1; // OPEN
        if (this.onopen) {
            this.onopen(new Event('open'));
        }
    }

    simulateMessage(data: unknown): void {
        if (typeof data === 'object' && data !== null && 'id' in data) {
            const id = (data as { id: number | string }).id;
            const resolver = this._pendingRpc.get(id);
            if (resolver) {
                this._pendingRpc.delete(id);
                resolver(
                    new Response(JSON.stringify(data), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    }),
                );
                return;
            }
        }
        if (this.onmessage) {
            this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
        }
    }

    onClientRequest(handler: (msg: Record<string, unknown>) => void): void {
        this._messageHandlers.push(handler);
    }

    async fetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        this.fetchBodies.push(bodyStr);
        let parsed: Record<string, unknown> = {};
        try {
            parsed = JSON.parse(bodyStr) as Record<string, unknown>;
        } catch {
            return new Response('Invalid JSON', { status: 400 });
        }

        const id = parsed.id as number | string | undefined;

        if (id === undefined) {
            queueMicrotask(() => {
                for (const handler of [...this._messageHandlers]) {
                    handler(parsed);
                }
            });
            return new Response(null, { status: 204 });
        }

        return new Promise<Response>((resolve, reject) => {
            const onAbort = () => {
                this._pendingRpc.delete(id);
                reject(new Error('Request aborted'));
            };

            if (init?.signal?.aborted) {
                onAbort();
                return;
            }
            init?.signal?.addEventListener('abort', onAbort, { once: true });

            this._pendingRpc.set(id, (resp) => {
                init?.signal?.removeEventListener('abort', onAbort);
                resolve(resp);
            });

            queueMicrotask(() => {
                for (const handler of [...this._messageHandlers]) {
                    handler(parsed);
                }
            });
        });
    }
}

function setupRemoteHost(options?: {
    platform?: 'linux' | 'darwin' | 'win32';
    tempDir?: string;
    repoRoot?: string;
    version?: string;
}): { host: RemoteHostSystem; fakeWs: FakeDaemonTransport } {
    const fakeWs = new FakeDaemonTransport();

    const host = new RemoteHostSystem({
        url: 'http://127.0.0.1:8080?token=test-token',
        clientId: 'mock-client-id',
        eventSourceFactory: () => fakeWs,
        fetch: fakeWs.fetch,
        reconnect: false,
        useWebSocket: false,
    });

    fakeWs.onClientRequest((msg) => {
        if (msg.method === 'system.info') {
            fakeWs.simulateMessage({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                    platform: options?.platform ?? 'linux',
                    version: options?.version ?? '1.0.0',
                    repoRoot: options?.repoRoot ?? '/mock/repo',
                    tempDir: options?.tempDir ?? '/mock/daemon-temp',
                },
            });
        }
    });

    fakeWs.open();
    return { host, fakeWs };
}

describe('RemoteHostSystem Unit Tests', () => {
    describe('Initialization & System Info Handshake', () => {
        it('performs handshake upon connection open and exposes system properties', async () => {
            const { host, fakeWs } = setupRemoteHost({
                platform: 'darwin',
                tempDir: '/tmp/private-jj-daemon',
                repoRoot: '/workspace/project',
                version: '2.5.0',
            });

            await host.ready;

            expect(host.isConnected).toBe(true);
            expect(host.platform).toBe('darwin');
            expect(host.tempDir).toBe('/tmp/private-jj-daemon');
            expect(host.repoRoot).toBe('/workspace/project');
            expect(host.version).toBe('2.5.0');

            host.dispose();
            expect(fakeWs.readyState).toBe(2);
        });

        it('resolves wss protocol and host in https browser environment', async () => {
            const originalWindow = globalThis.window;
            try {
                const mockWindow = {
                    location: {
                        protocol: 'https:',
                        host: 'code.example.com:8443',
                        hostname: 'code.example.com',
                        port: '8443',
                    },
                    __JJ_VIEW_CONFIG__: {
                        token: 'browser-token',
                    },
                };
                Object.defineProperty(globalThis, 'window', {
                    value: mockWindow,
                    configurable: true,
                    writable: true,
                });

                let connectedUrl = '';
                const fakeWs = new FakeDaemonTransport();
                const host = new RemoteHostSystem({
                    clientId: 'test-client-id',
                    eventSourceFactory: (url: string) => {
                        connectedUrl = url;
                        return fakeWs;
                    },
                    fetch: fakeWs.fetch,
                    reconnect: false,
                    useWebSocket: false,
                });

                expect(connectedUrl).toBe(
                    'https://code.example.com:8443/api/events?clientId=test-client-id&token=browser-token',
                );
                host.dispose();
            } finally {
                Object.defineProperty(globalThis, 'window', {
                    value: originalWindow,
                    configurable: true,
                    writable: true,
                });
            }
        });

        it('resolves session token from window.location.search when __JJ_VIEW_CONFIG__ has no token', () => {
            const originalWindow = globalThis.window;
            try {
                const mockWindow = {
                    location: {
                        protocol: 'http:',
                        host: '127.0.0.1:5173',
                        hostname: '127.0.0.1',
                        port: '5173',
                        search: '?token=vite-dev-token&repo=%2Fsome%2Frepo',
                    },
                };
                Object.defineProperty(globalThis, 'window', {
                    value: mockWindow,
                    configurable: true,
                    writable: true,
                });

                let connectedUrl = '';
                const fakeWs = new FakeDaemonTransport();
                const host = new RemoteHostSystem({
                    clientId: 'test-client-id',
                    eventSourceFactory: (url: string) => {
                        connectedUrl = url;
                        return fakeWs;
                    },
                    fetch: fakeWs.fetch,
                    reconnect: false,
                    useWebSocket: false,
                });

                expect(connectedUrl).toBe(
                    'http://127.0.0.1:5173/api/events?clientId=test-client-id&token=vite-dev-token',
                );
                host.dispose();
            } finally {
                Object.defineProperty(globalThis, 'window', {
                    value: originalWindow,
                    configurable: true,
                    writable: true,
                });
            }
        });
    });

    describe('Process Execution (HostProcess)', () => {
        it('executes command successfully over JSON-RPC', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'process.execFile') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: {
                            stdout: 'commit 12345\n',
                            stderr: '',
                            exitCode: 0,
                        },
                    });
                }
            });

            let spawned = false;
            const res = await host.process.execFile('jj', ['log', '-r', '@'], {
                cwd: '/workspace/project',
                onSpawn: (proc) => {
                    if (proc.kill) {
                        spawned = true;
                    }
                },
            });

            expect(spawned).toBe(true);
            expect(res.exitCode).toBe(0);
            expect(res.stdout).toBe('commit 12345\n');
            expect(res.stderr).toBe('');

            host.dispose();
        });

        it('throws ProcessExitError on non-zero exit code from daemon', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'process.execFile') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        error: {
                            code: RPC_CODE_PROCESS_ERROR,
                            message: 'exit status 1',
                            data: {
                                exitCode: 1,
                                stdout: '',
                                stderr: 'Error: Working copy is dirty\n',
                            },
                        },
                    });
                }
            });

            await expect(host.process.execFile('jj', ['squash'])).rejects.toThrow(ProcessExitError);

            try {
                await host.process.execFile('jj', ['squash']);
            } catch (err) {
                expect(err).toBeInstanceOf(ProcessExitError);
                if (err instanceof ProcessExitError) {
                    expect(err.exitCode).toBe(1);
                    expect(err.stderr).toBe('Error: Working copy is dirty\n');
                }
            }

            host.dispose();
        });

        it('cancels process and sends $/cancelRequest when proc.kill() is called', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            const cancelPromise = new Promise<Record<string, unknown>>((resolve) => {
                fakeWs.onClientRequest((msg) => {
                    if (msg.method === '$/cancelRequest') {
                        resolve(msg);
                    }
                });
            });

            const reqReceivedPromise = new Promise<void>((resolve) => {
                fakeWs.onClientRequest((msg) => {
                    if (msg.method === 'process.execFile') {
                        resolve();
                    }
                });
            });

            let spawnedProc: TrackableProcess | undefined;
            const execPromise = host.process.execFile('jj', ['log'], {
                onSpawn: (proc) => {
                    spawnedProc = proc;
                },
            });

            await reqReceivedPromise;
            expect(spawnedProc).toBeDefined();
            expect(spawnedProc?.killed).toBeFalsy();

            spawnedProc?.kill?.();
            expect(spawnedProc?.killed).toBe(true);

            await expect(execPromise).rejects.toThrow('Request aborted');
            const cancelMsg = await cancelPromise;
            expect(cancelMsg.method).toBe('$/cancelRequest');

            host.dispose();
        });

        it('throws standard Error on generic daemon error', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'process.execFile') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        error: {
                            code: RPC_CODE_INTERNAL_ERROR,
                            message: 'executable not found',
                        },
                    });
                }
            });

            await expect(host.process.execFile('jj', ['version'])).rejects.toThrow('executable not found');
            host.dispose();
        });

        it('sends $/cancelRequest notification when AbortSignal aborts in flight', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            const abortController = new AbortController();

            const cancelPromise = new Promise<Record<string, unknown>>((resolve) => {
                fakeWs.onClientRequest((msg) => {
                    if (msg.method === '$/cancelRequest') {
                        resolve(msg);
                    }
                });
            });

            const reqReceivedPromise = new Promise<void>((resolve) => {
                fakeWs.onClientRequest((msg) => {
                    if (msg.method === 'process.execFile') {
                        resolve();
                    }
                });
            });

            const execPromise = host.process.execFile('jj', ['log'], { signal: abortController.signal });
            await reqReceivedPromise;
            abortController.abort();

            await expect(execPromise).rejects.toThrow('Request aborted');
            const cancelMsg = await cancelPromise;
            expect(cancelMsg.method).toBe('$/cancelRequest');
            expect(cancelMsg.params).toBeDefined();

            host.dispose();
        });

        it('rejects immediately if AbortSignal is already aborted', async () => {
            const { host } = setupRemoteHost();
            await host.ready;

            const abortController = new AbortController();
            abortController.abort();

            await expect(host.process.execFile('jj', ['log'], { signal: abortController.signal })).rejects.toThrow(
                'Request aborted',
            );

            host.dispose();
        });

        it('resolves helper script path', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'process.getHelperScriptPath') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { path: '/tmp/private-scripts/batch-diff.sh' },
                    });
                }
            });

            const scriptPath = await host.process.getHelperScriptPath('batch-diff');
            expect(scriptPath).toBe('/tmp/private-scripts/batch-diff.sh');

            host.dispose();
        });
    });

    describe('Filesystem Operations (HostFs)', () => {
        it('reads and writes text files with base64 transcoding', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            let storedBase64 = '';
            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'fs.writeFile') {
                    if (
                        typeof msg.params === 'object' &&
                        msg.params !== null &&
                        'content' in msg.params &&
                        typeof (msg.params as { content: unknown }).content === 'string'
                    ) {
                        storedBase64 = (msg.params as { content: string }).content;
                    }
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { success: true },
                    });
                }
                if (msg.method === 'fs.readFiles') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { files: [{ content: storedBase64 }] },
                    });
                }
            });

            await host.fs.writeTextFile('/mock/repo/test.txt', 'hello world from host');
            const text = await host.fs.readTextFile('/mock/repo/test.txt');
            expect(text).toBe('hello world from host');

            host.dispose();
        });

        it('handles empty string and empty binary payload transcoding', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            let storedBase64 = '';
            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'fs.writeFile') {
                    if (
                        typeof msg.params === 'object' &&
                        msg.params !== null &&
                        'content' in msg.params &&
                        typeof (msg.params as { content: unknown }).content === 'string'
                    ) {
                        storedBase64 = (msg.params as { content: string }).content;
                    }
                    fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { success: true } });
                }
                if (msg.method === 'fs.readFiles') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { files: [{ content: storedBase64 }] },
                    });
                }
            });

            await host.fs.writeTextFile('/mock/repo/empty.txt', '');
            const text = await host.fs.readTextFile('/mock/repo/empty.txt');
            expect(text).toBe('');

            await host.fs.writeBinaryFile('/mock/repo/empty.bin', new Uint8Array(0));
            const bin = await host.fs.readBinaryFile('/mock/repo/empty.bin');
            expect(bin.length).toBe(0);

            host.dispose();
        });

        it('reads and writes binary files with Uint8Array', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            const binaryPayload = new Uint8Array([0, 1, 2, 3, 254, 255]);
            let storedBase64 = '';

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'fs.writeFile') {
                    if (
                        typeof msg.params === 'object' &&
                        msg.params !== null &&
                        'content' in msg.params &&
                        typeof (msg.params as { content: unknown }).content === 'string'
                    ) {
                        storedBase64 = (msg.params as { content: string }).content;
                    }
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { success: true },
                    });
                }
                if (msg.method === 'fs.readFiles') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { files: [{ content: storedBase64 }] },
                    });
                }
            });

            await host.fs.writeBinaryFile('/mock/repo/bin.dat', binaryPayload);
            const readBack = await host.fs.readBinaryFile('/mock/repo/bin.dat');
            expect(Array.from(readBack)).toEqual(Array.from(binaryPayload));

            host.dispose();
        });

        it('maps per-entry ENOENT error to HostSystemError with code ENOENT', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'fs.readFiles') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: {
                            files: [
                                { error: { code: 'ENOENT', message: 'open /mock/repo/missing.txt: no such file' } },
                            ],
                        },
                    });
                }
            });

            try {
                await host.fs.readTextFile('/mock/repo/missing.txt');
                expect.unreachable('Should have thrown ENOENT error');
            } catch (err) {
                expect(err).toBeInstanceOf(HostSystemError);
                if (err instanceof HostSystemError) {
                    expect(err.code).toBe('ENOENT');
                }
            }

            host.dispose();
        });

        it('coalesces reads issued in the same microtask into one fs.readFiles RPC with per-entry results', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            const requestedBatches: string[][] = [];
            fakeWs.onClientRequest((msg) => {
                if (msg.method !== 'fs.readFiles') {
                    return;
                }
                const paths = (msg.params as { paths: string[] }).paths;
                requestedBatches.push(paths);
                fakeWs.simulateMessage({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {
                        files: paths.map((p) => {
                            if (p.endsWith('missing.txt')) {
                                return { error: { code: 'ENOENT', message: `missing: ${p}` } };
                            }
                            if (p.endsWith('denied.txt')) {
                                return { error: { message: `access denied: ${p}` } };
                            }
                            return { content: Buffer.from(`content of ${p}`, 'utf8').toString('base64') };
                        }),
                    },
                });
            });

            // Three independent callers, same tick, mixed single/batch/binary APIs.
            const results = await Promise.allSettled([
                host.fs.readTextFile('/mock/repo/a.txt'),
                host.fs.readTextFile('/mock/repo/missing.txt'),
                host.fs.readBinaryFile('/mock/repo/denied.txt'),
                host.fs.readTextFiles(['/mock/repo/b.txt', '/mock/repo/missing.txt']),
            ]);

            expect(requestedBatches).toEqual([
                [
                    '/mock/repo/a.txt',
                    '/mock/repo/missing.txt',
                    '/mock/repo/denied.txt',
                    '/mock/repo/b.txt',
                    '/mock/repo/missing.txt',
                ],
            ]);

            expect(results[0]).toEqual({ status: 'fulfilled', value: 'content of /mock/repo/a.txt' });
            expect(results[1].status).toBe('rejected');
            if (results[1].status === 'rejected') {
                expect(results[1].reason).toBeInstanceOf(HostSystemError);
                expect((results[1].reason as HostSystemError).code).toBe('ENOENT');
            }
            expect(results[2].status).toBe('rejected');
            if (results[2].status === 'rejected') {
                expect(results[2].reason).not.toBeInstanceOf(HostSystemError);
                expect((results[2].reason as Error).message).toContain('access denied');
            }
            expect(results[3]).toEqual({ status: 'fulfilled', value: ['content of /mock/repo/b.txt', null] });

            host.dispose();
        });

        it('does not coalesce reads issued in different microtasks', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            const requestedBatches: string[][] = [];
            fakeWs.onClientRequest((msg) => {
                if (msg.method !== 'fs.readFiles') {
                    return;
                }
                const paths = (msg.params as { paths: string[] }).paths;
                requestedBatches.push(paths);
                fakeWs.simulateMessage({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: { files: paths.map(() => ({ content: '' })) },
                });
            });

            await host.fs.readTextFile('/mock/repo/first.txt');
            await host.fs.readTextFile('/mock/repo/second.txt');

            expect(requestedBatches).toEqual([['/mock/repo/first.txt'], ['/mock/repo/second.txt']]);
            host.dispose();
        });

        it('rejects every coalesced read when the batch RPC itself fails', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'fs.readFiles') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        error: { code: RPC_CODE_INTERNAL_ERROR, message: 'daemon exploded' },
                    });
                }
            });

            const results = await Promise.allSettled([
                host.fs.readTextFile('/mock/repo/a.txt'),
                host.fs.readTextFile('/mock/repo/b.txt'),
            ]);
            for (const r of results) {
                expect(r.status).toBe('rejected');
                if (r.status === 'rejected') {
                    expect((r.reason as Error).message).toBe('daemon exploded');
                }
            }
            host.dispose();
        });

        it('readTextFiles rethrows non-ENOENT per-entry errors', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'fs.readFiles') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: {
                            files: [{ content: '' }, { error: { code: 'EACCES', message: 'permission denied' } }],
                        },
                    });
                }
            });

            await expect(host.fs.readTextFiles(['/mock/repo/ok.txt', '/mock/repo/locked.txt'])).rejects.toThrow(
                'permission denied',
            );
            host.dispose();
        });
    });

    describe('Scratch Directory Execution', () => {
        it('sends one process.execFileInScratchDir request and maps the result', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            let received: unknown;
            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'process.execFileInScratchDir') {
                    received = msg.params;
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: {
                            scratchDir: '/tmp/daemon/jj-bulk-diff-abc',
                            stdout: '',
                            stderr: 'aborted by tool',
                            exitCode: 1,
                            markerPresent: true,
                        },
                    });
                }
            });

            let spawned = false;
            const res = await host.process.execFileInScratchDir({
                file: 'jj',
                args: ['diffedit', '--tool', 'x', '{{scratchDir}}/left', '{{helperScript}}'],
                scratchPrefix: 'jj-bulk-diff-',
                subdirs: ['left', 'right'],
                helperScript: 'batch-diff',
                completionMarker: 'right/.complete',
                options: {
                    cwd: '/workspace/project',
                    env: { JJ_VIEW_EXTENSION: '1' },
                    onSpawn: () => {
                        spawned = true;
                    },
                },
            });

            expect(spawned).toBe(true);
            expect(received).toEqual({
                file: 'jj',
                args: ['diffedit', '--tool', 'x', '{{scratchDir}}/left', '{{helperScript}}'],
                scratchPrefix: 'jj-bulk-diff-',
                subdirs: ['left', 'right'],
                helperScript: 'batch-diff',
                completionMarker: 'right/.complete',
                cwd: '/workspace/project',
                env: { JJ_VIEW_EXTENSION: '1' },
                timeout: undefined,
                maxBuffer: undefined,
            });
            // Non-zero exit is data, not an exception, so the caller can consult markerPresent.
            expect(res).toEqual({
                scratchDir: '/tmp/daemon/jj-bulk-diff-abc',
                stdout: '',
                stderr: 'aborted by tool',
                exitCode: 1,
                markerPresent: true,
            });

            host.dispose();
        });
    });

    describe('Filesystem Metadata Operations (HostFs)', () => {
        it('handles stat and lstat queries', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'fs.stat') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: {
                            isFile: true,
                            isDirectory: false,
                            isSymbolicLink: false,
                            mtimeMs: 1700000000000,
                            size: 1024,
                        },
                    });
                }
                if (msg.method === 'fs.lstat') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: {
                            isFile: false,
                            isDirectory: false,
                            isSymbolicLink: true,
                            mtimeMs: 1700000000000,
                            size: 32,
                        },
                    });
                }
            });

            const st = await host.fs.stat('/mock/repo/file.txt');
            expect(st.isFile()).toBe(true);
            expect(st.isDirectory()).toBe(false);
            expect(st.isSymbolicLink()).toBe(false);
            expect(st.size).toBe(1024);

            const lst = await host.fs.lstat('/mock/repo/symlink');
            expect(lst.isFile()).toBe(false);
            expect(lst.isSymbolicLink()).toBe(true);
            expect(lst.size).toBe(32);

            host.dispose();
        });

        it('handles mkdir, readdir, exists, realpath, mkdtemp, and rm', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            fakeWs.onClientRequest((msg) => {
                switch (msg.method) {
                    case 'fs.mkdir':
                        fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { success: true } });
                        break;
                    case 'fs.readdir':
                        fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { files: ['a.txt', 'b.txt'] } });
                        break;
                    case 'fs.exists':
                        fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { exists: true } });
                        break;
                    case 'fs.realpath':
                        fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { resolvedPath: '/real/path' } });
                        break;
                    case 'fs.mkdtemp':
                        fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { path: '/tmp/temp-dir-123' } });
                        break;
                    case 'fs.rm':
                        fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { success: true } });
                        break;
                }
            });

            await host.fs.mkdir('/mock/repo/nested', { recursive: true });
            const files = await host.fs.readdir('/mock/repo');
            expect(files).toEqual(['a.txt', 'b.txt']);

            const exists = await host.fs.exists('/mock/repo/a.txt');
            expect(exists).toBe(true);

            const real = await host.fs.realpath('/mock/repo/symlink');
            expect(real).toBe('/real/path');
            const realCached = await host.fs.realpath('/mock/repo/symlink');
            expect(realCached).toBe('/real/path');

            const temp = await host.fs.mkdtemp('test-prefix-');
            expect(temp).toBe('/tmp/temp-dir-123');

            await host.fs.rm('/mock/repo/nested', { recursive: true, force: true });
            await host.fs.unlink('/mock/repo/a.txt');

            host.dispose();
        });
    });

    describe('File Watching (HostWatcher)', () => {
        it('subscribes to directory watch events and dispatches notifications', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'watcher.watch') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { subscriptionId: 'sub-42' },
                    });
                }
                if (msg.method === 'watcher.unwatch') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { success: true },
                    });
                }
            });

            const receivedEvents: Array<{ path: string; type: string }> = [];
            const sub = await host.watcher.watch('/mock/repo', (_err, events) => {
                receivedEvents.push(...events);
            });

            // Simulate incoming server notification
            fakeWs.simulateMessage({
                jsonrpc: '2.0',
                method: 'watcher.change',
                params: {
                    subscriptionId: 'sub-42',
                    events: [
                        { path: '/mock/repo/file.txt', type: 'create' },
                        { path: '/mock/repo/other.txt', type: 'update' },
                    ],
                },
            });

            expect(receivedEvents).toHaveLength(2);
            expect(receivedEvents[0]).toEqual({ path: '/mock/repo/file.txt', type: 'create' });
            expect(receivedEvents[1]).toEqual({ path: '/mock/repo/other.txt', type: 'update' });

            await sub.unsubscribe();
            host.dispose();
        });

        it('unregisters updated subscriptionId on unsubscribe after reconnection', async () => {
            let currentWs = new FakeDaemonTransport();
            let subIdCounter = 0;
            const unwatchCalls: string[] = [];

            const host = new RemoteHostSystem({
                url: 'http://127.0.0.1:8080?token=test-token',
                eventSourceFactory: () => {
                    const ws = new FakeDaemonTransport();
                    currentWs = ws;
                    ws.onClientRequest((msg) => {
                        if (msg.method === 'system.info') {
                            ws.simulateMessage({
                                jsonrpc: '2.0',
                                id: msg.id,
                                result: { platform: 'linux', version: '1.0.0', repoRoot: '/mock/repo' },
                            });
                        }
                        if (msg.method === 'watcher.watch') {
                            subIdCounter++;
                            ws.simulateMessage({
                                jsonrpc: '2.0',
                                id: msg.id,
                                result: { subscriptionId: `sub-${subIdCounter}` },
                            });
                        }
                        if (msg.method === 'watcher.unwatch') {
                            if (
                                typeof msg.params === 'object' &&
                                msg.params !== null &&
                                'subscriptionId' in msg.params &&
                                typeof (msg.params as { subscriptionId: unknown }).subscriptionId === 'string'
                            ) {
                                unwatchCalls.push((msg.params as { subscriptionId: string }).subscriptionId);
                            }
                            ws.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { success: true } });
                        }
                    });
                    return ws;
                },
                fetch: (input, init) => currentWs.fetch(input, init),
                reconnect: true,
                reconnectDelayMs: 20,
            });

            currentWs.open();
            await host.ready;

            const sub = await host.watcher.watch('/mock/repo', () => {});
            expect(subIdCounter).toBe(1);

            // Disconnect and trigger reconnect
            currentWs.close(1006, 'Abnormal Closure');
            await new Promise((r) => setTimeout(r, 50));
            currentWs.open();
            await host.ready;
            await new Promise((r) => setTimeout(r, 50));
            expect(subIdCounter).toBe(2);

            // Unsubscribe after reconnect
            await sub.unsubscribe();
            // Verify unwatch was called with 'sub-2' (the updated subscription ID), not 'sub-1'
            expect(unwatchCalls).toEqual(['sub-2']);

            host.dispose();
        });
    });

    describe('Daemon Configuration Store', () => {
        it('gets, sets, and lists daemon config values', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'config.set') {
                    fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { success: true } });
                }
                if (msg.method === 'config.get') {
                    const params = msg.params as { key: string; scope?: string };
                    const value = params.scope === 'workspace' ? 'workspace-theme' : 'dark';
                    fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { value, found: true } });
                }
                if (msg.method === 'config.getAll') {
                    fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { theme: 'dark', autoFetch: true } });
                }
            });

            await host.setConfig('theme', 'dark', 'user');
            const val = await host.getConfig<string>('theme');
            expect(val).toBe('dark');

            const wsVal = await host.getConfig<string>('theme', 'workspace');
            expect(wsVal).toBe('workspace-theme');

            const all = await host.getAllConfig('effective');
            expect(all).toEqual({ theme: 'dark', autoFetch: true });

            // Test onConfigDidChange notification
            let receivedKey = '';
            let receivedScope = '';
            const sub = host.onConfigDidChange((key, scope) => {
                receivedKey = key;
                receivedScope = scope;
            });

            fakeWs.simulateMessage({
                jsonrpc: '2.0',
                method: 'config/didChange',
                params: { key: 'logTheme', scope: 'workspace' },
            });

            expect(receivedKey).toBe('logTheme');
            expect(receivedScope).toBe('workspace');

            sub.dispose();
            host.dispose();
        });
    });

    describe('Lifecycle, Reconnection & Edge Cases', () => {
        it('handles multibyte UTF-8 characters (emojis, CJK) in text files', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            const unicodeText = 'Hello 🚀 世界 \n \t \u0000 special symbols: ⚡️';
            let storedBase64 = '';

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'fs.writeFile') {
                    if (
                        typeof msg.params === 'object' &&
                        msg.params !== null &&
                        'content' in msg.params &&
                        typeof (msg.params as { content: unknown }).content === 'string'
                    ) {
                        storedBase64 = (msg.params as { content: string }).content;
                    }
                    fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { success: true } });
                }
                if (msg.method === 'fs.readFiles') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { files: [{ content: storedBase64 }] },
                    });
                }
            });

            await host.fs.writeTextFile('/mock/repo/unicode.txt', unicodeText);
            const retrieved = await host.fs.readTextFile('/mock/repo/unicode.txt');
            expect(retrieved).toBe(unicodeText);

            host.dispose();
        });

        it('times out requests when daemon does not respond', async () => {
            const fakeWs = new FakeDaemonTransport();
            const host = new RemoteHostSystem({
                url: 'http://127.0.0.1:8080?token=test-token',
                eventSourceFactory: () => fakeWs,
                fetch: fakeWs.fetch,
                requestTimeoutMs: 50,
                reconnect: false,
                useWebSocket: false,
            });

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'system.info') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { platform: 'linux', version: '1.0.0', repoRoot: '/mock/repo' },
                    });
                }
            });
            fakeWs.open();
            await host.ready;

            const cancelPromise = new Promise<Record<string, unknown>>((resolve) => {
                fakeWs.onClientRequest((msg) => {
                    if (msg.method === '$/cancelRequest') {
                        resolve(msg);
                    }
                });
            });

            await expect(host.fs.exists('/mock/repo/file.txt')).rejects.toThrow('timed out after 50ms');
            const cancelMsg = await cancelPromise;
            expect(cancelMsg.method).toBe('$/cancelRequest');

            host.dispose();
        });

        it('rejects ready promise when eventSourceFactory throws synchronously', async () => {
            const host = new RemoteHostSystem({
                url: 'http://invalid-url',
                eventSourceFactory: () => {
                    throw new Error('CSP blocked');
                },
                reconnect: false,
                useWebSocket: false,
            });

            await expect(host.ready).rejects.toThrow('CSP blocked');
            host.dispose();
        });

        it('rejects ready promise when reconnection fails and stops', async () => {
            const fakeWs = new FakeDaemonTransport();
            const host = new RemoteHostSystem({
                url: 'http://127.0.0.1:8080?token=test-token',
                eventSourceFactory: () => fakeWs,
                fetch: fakeWs.fetch,
                reconnect: false,
                useWebSocket: false,
            });

            fakeWs.open();
            fakeWs.simulateMessage({
                jsonrpc: '2.0',
                id: 1,
                result: { platform: 'linux', version: '1.0.0', repoRoot: '/mock/repo' },
            });
            await host.ready;

            fakeWs.close(1006, 'Abnormal Closure');
            await expect(host.ready).rejects.toThrow('reconnection stopped');

            host.dispose();
        });

        it('re-subscribes active file watchers on reconnection', async () => {
            let currentWs = new FakeDaemonTransport();
            let connectionCount = 0;

            const host = new RemoteHostSystem({
                url: 'http://127.0.0.1:8080?token=test-token',
                eventSourceFactory: () => {
                    connectionCount++;
                    const ws = new FakeDaemonTransport();
                    currentWs = ws;
                    ws.onClientRequest((msg) => {
                        if (msg.method === 'system.info') {
                            ws.simulateMessage({
                                jsonrpc: '2.0',
                                id: msg.id,
                                result: { platform: 'linux', version: '1.0.0', repoRoot: '/mock/repo' },
                            });
                        }
                    });
                    return ws;
                },
                fetch: (input, init) => currentWs.fetch(input, init),
                reconnect: true,
                reconnectDelayMs: 20,
            });

            currentWs.open();
            await host.ready;

            let watchCalls = 0;
            currentWs.onClientRequest((msg) => {
                if (msg.method === 'watcher.watch') {
                    watchCalls++;
                    currentWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { subscriptionId: `sub-${watchCalls}` },
                    });
                }
            });

            await host.watcher.watch('/mock/repo', () => {});
            expect(watchCalls).toBe(1);

            // Simulate disconnect
            currentWs.close(1006, 'Abnormal Closure');
            expect(host.isConnected).toBe(false);

            // Wait for reconnect attempt
            await new Promise((resolve) => setTimeout(resolve, 50));
            const reconnectedWs = currentWs;
            reconnectedWs.onClientRequest((msg) => {
                if (msg.method === 'watcher.watch') {
                    watchCalls++;
                    reconnectedWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { subscriptionId: `sub-${watchCalls}` },
                    });
                }
            });

            reconnectedWs.open();
            await host.ready;

            // Wait a tick for _reconnectWatchers
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(watchCalls).toBe(2);
            expect(connectionCount).toBe(2);

            host.dispose();
        });

        it('rejects pending requests and closes socket on dispose', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            const pendingPromise = host.fs.exists('/mock/repo/hang.txt');
            host.dispose();

            await expect(pendingPromise).rejects.toThrow('RemoteHostSystem is disposed');
            expect(host.isConnected).toBe(false);
            expect(fakeWs.readyState).toBe(2); // CLOSED

            await expect(host.fs.exists('/mock/repo/after.txt')).rejects.toThrow('RemoteHostSystem is disposed');
        });

        it('restores token from sessionStorage and persists token to sessionStorage', async () => {
            const mockStorage = new Map<string, string>();
            const fakeSessionStorage = {
                getItem: (k: string) => mockStorage.get(k) ?? null,
                setItem: (k: string, v: string) => mockStorage.set(k, v),
                removeItem: (k: string) => mockStorage.delete(k),
                clear: () => mockStorage.clear(),
                length: 0,
                key: () => null,
            };

            const origWindow = globalThis.window;
            let capturedUrl = '';

            try {
                // Pre-populate sessionStorage
                mockStorage.set('jj_view_token', 'stored-token-123');

                (globalThis as unknown as { window: unknown }).window = {
                    location: {
                        host: '127.0.0.1:5173',
                        protocol: 'http:',
                        search: '',
                    },
                    sessionStorage: fakeSessionStorage,
                };

                const fakeWs = new FakeDaemonTransport();
                const host1 = new RemoteHostSystem({
                    clientId: 'test-client-id',
                    eventSourceFactory: (u: string) => {
                        capturedUrl = u;
                        return fakeWs;
                    },
                    fetch: fakeWs.fetch,
                    reconnect: false,
                    useWebSocket: false,
                });

                expect(capturedUrl).toContain('token=stored-token-123');
                host1.dispose();

                // Test persistence: query token gets stored
                mockStorage.clear();
                (globalThis as unknown as { window: unknown }).window = {
                    location: {
                        host: '127.0.0.1:5173',
                        protocol: 'http:',
                        search: '?token=query-token-456',
                    },
                    sessionStorage: fakeSessionStorage,
                };

                const fakeWs2 = new FakeDaemonTransport();
                const host2 = new RemoteHostSystem({
                    clientId: 'test-client-id',
                    eventSourceFactory: (u: string) => {
                        capturedUrl = u;
                        return fakeWs2;
                    },
                    fetch: fakeWs2.fetch,
                    reconnect: false,
                    useWebSocket: false,
                });

                expect(capturedUrl).toContain('token=query-token-456');
                expect(mockStorage.get('jj_view_token')).toBe('query-token-456');
                host2.dispose();
            } finally {
                (globalThis as unknown as { window: unknown }).window = origWindow;
            }
        });
    });
});

class FakeRpcSocket implements WebSocketLike {
    public readyState = 0;
    public readonly sent: string[] = [];
    public onopen: ((ev: Event) => void) | null = null;
    public onmessage: ((ev: MessageEvent) => void) | null = null;
    public onclose: ((ev: CloseEvent) => void) | null = null;
    public onerror: ((ev: Event) => void) | null = null;

    send(data: string): void {
        this.sent.push(data);
    }

    close(code?: number, reason?: string): void {
        this.serverClose(code ?? 1005, reason ?? '');
    }

    open(): void {
        this.readyState = 1;
        this.onopen?.(new Event('open'));
    }

    reply(id: unknown, result: unknown): void {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id, result }) }));
    }

    serverClose(code: number, reason: string): void {
        if (this.readyState === 3) {
            return;
        }
        this.readyState = 3;
        this.onclose?.(Object.assign(new Event('close'), { code, reason, wasClean: true }) as CloseEvent);
    }

    sentFrames(): Array<Record<string, unknown>> {
        return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    }
}

interface SocketHostSetup {
    host: RemoteHostSystem;
    daemon: FakeDaemonTransport;
    socket: FakeRpcSocket;
    readonly wsUrl: string;
}

/** request() awaits `ready` before writing the frame; let pending microtasks run. */
async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function setupHostWithSocket(): SocketHostSetup {
    const daemon = new FakeDaemonTransport();
    const socket = new FakeRpcSocket();
    let wsUrl = '';
    const host = new RemoteHostSystem({
        url: 'http://127.0.0.1:8080?token=test-token',
        clientId: 'mock-client-id',
        eventSourceFactory: () => daemon,
        fetch: daemon.fetch,
        webSocketFactory: (url) => {
            wsUrl = url;
            return socket;
        },
        reconnect: false,
    });
    daemon.onClientRequest((msg) => {
        if (msg.method === 'system.info') {
            daemon.simulateMessage({
                jsonrpc: '2.0',
                id: msg.id,
                result: { platform: 'linux', version: '1.0.0', repoRoot: '/mock/repo', tempDir: '/tmp' },
            });
        }
    });
    daemon.open();
    return {
        host,
        daemon,
        socket,
        get wsUrl() {
            return wsUrl;
        },
    };
}

describe('RemoteHostSystem WebSocket routing', () => {
    it('opens the socket only after system.info succeeds over HTTP, with clientId and token', async () => {
        const setup = setupHostWithSocket();
        expect(setup.wsUrl).toBe('');
        await setup.host.ready;
        const url = new URL(setup.wsUrl);
        expect(url.protocol).toBe('ws:');
        expect(url.pathname).toBe('/api/ws');
        expect(url.searchParams.get('clientId')).toBe('mock-client-id');
        expect(url.searchParams.get('token')).toBe('test-token');
        setup.host.dispose();
    });

    it('falls back to HTTP while the socket is not open', async () => {
        const { host, daemon, socket } = setupHostWithSocket();
        await host.ready;
        daemon.onClientRequest((msg) => {
            if (msg.method === 'fs.exists') {
                daemon.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { exists: true } });
            }
        });
        const before = daemon.fetchBodies.length;
        await expect(host.fs.exists('/mock/repo/x')).resolves.toBe(true);
        expect(socket.sent).toHaveLength(0);
        expect(daemon.fetchBodies.length).toBe(before + 1);
        host.dispose();
    });

    it('routes requests and notifications over the socket once it is open', async () => {
        const { host, daemon, socket } = setupHostWithSocket();
        await host.ready;
        socket.open();

        const httpBefore = daemon.fetchBodies.length;
        const pending = host.fs.exists('/mock/repo/x');
        await settle();
        const [req] = socket.sentFrames();
        expect(req?.method).toBe('fs.exists');
        socket.reply(req?.id, { exists: true });
        await expect(pending).resolves.toBe(true);
        expect(daemon.fetchBodies.length).toBe(httpBefore);

        host.notify('watcher.unwatch', { subscriptionId: 's1' });
        expect(socket.sentFrames().at(-1)).toMatchObject({ method: 'watcher.unwatch' });
        expect(daemon.fetchBodies.length).toBe(httpBefore);
        host.dispose();
    });

    it('sends $/cancelRequest over the socket when a socket-routed request is aborted', async () => {
        const { host, socket } = setupHostWithSocket();
        await host.ready;
        socket.open();

        const controller = new AbortController();
        const pending = host.request('process.execFile', { file: 'jj', args: ['log'] }, controller.signal);
        await settle();
        const [req] = socket.sentFrames();
        expect(req?.method).toBe('process.execFile');
        controller.abort(new Error('user cancelled'));
        await expect(pending).rejects.toThrow('Request aborted');
        expect(socket.sentFrames().at(-1)).toMatchObject({ method: '$/cancelRequest', params: { id: req?.id } });
        host.dispose();
    });

    it('fails in-flight socket requests on close and uses HTTP for the next request', async () => {
        const { host, daemon, socket } = setupHostWithSocket();
        await host.ready;
        socket.open();

        const pending = host.fs.exists('/mock/repo/x');
        await settle();
        expect(socket.sentFrames()).toHaveLength(1);
        socket.serverClose(1006, 'network');
        await expect(pending).rejects.toBeInstanceOf(WsTransportError);

        daemon.onClientRequest((msg) => {
            if (msg.method === 'fs.exists') {
                daemon.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { exists: false } });
            }
        });
        const httpBefore = daemon.fetchBodies.length;
        await expect(host.fs.exists('/mock/repo/y')).resolves.toBe(false);
        expect(daemon.fetchBodies.length).toBe(httpBefore + 1);
        host.dispose();
    });

    it('delivers notifications received on the socket to the same listeners as SSE', async () => {
        const { host, socket } = setupHostWithSocket();
        await host.ready;
        socket.open();
        const seen: string[] = [];
        host.onStateDidChange((key) => seen.push(key));
        socket.onmessage?.(
            new MessageEvent('message', {
                data: JSON.stringify({ jsonrpc: '2.0', method: 'state/didChange', params: { key: 'k' } }),
            }),
        );
        expect(seen).toEqual(['k']);
        host.dispose();
    });
});
