/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ProcessExitError, type TrackableProcess } from '../core/host/host-system';
import {
    HostSystemError,
    RemoteHostSystem,
    RPC_CODE_INTERNAL_ERROR,
    RPC_CODE_PROCESS_ERROR,
    type WebSocketLike,
} from '../core/host/remote-host-system';

class FakeCloseEvent extends Event {
    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;

    constructor(type: string, init?: { code?: number; reason?: string; wasClean?: boolean }) {
        super(type);
        this.code = init?.code ?? 1000;
        this.reason = init?.reason ?? '';
        this.wasClean = init?.wasClean ?? true;
    }
}

class FakeWebSocket implements WebSocketLike {
    public readyState: number = 0; // 0 = CONNECTING
    public sentMessages: string[] = [];
    public onopen: ((ev: Event) => void) | null = null;
    public onmessage: ((ev: MessageEvent) => void) | null = null;
    public onerror: ((ev: Event) => void) | null = null;
    public onclose: ((ev: CloseEvent) => void) | null = null;

    private readonly _messageHandlers: Array<(msg: Record<string, unknown>) => void> = [];

    send(data: string): void {
        this.sentMessages.push(data);
        const parsed = JSON.parse(data) as Record<string, unknown>;
        queueMicrotask(() => {
            for (const handler of [...this._messageHandlers]) {
                handler(parsed);
            }
        });
    }

    close(code: number = 1000, reason: string = ''): void {
        this.readyState = 3; // CLOSED
        if (this.onclose) {
            const CloseEventCtor = typeof CloseEvent !== 'undefined' ? CloseEvent : FakeCloseEvent;
            this.onclose(new CloseEventCtor('close', { code, reason }));
        }
    }

    open(): void {
        this.readyState = 1; // OPEN
        if (this.onopen) {
            this.onopen(new Event('open'));
        }
    }

    simulateMessage(data: unknown): void {
        if (this.onmessage) {
            this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
        }
    }

    onClientRequest(handler: (msg: Record<string, unknown>) => void): void {
        this._messageHandlers.push(handler);
    }
}

function setupRemoteHost(options?: {
    platform?: 'linux' | 'darwin' | 'win32';
    tempDir?: string;
    repoRoot?: string;
    version?: string;
}): { host: RemoteHostSystem; fakeWs: FakeWebSocket } {
    const fakeWs: FakeWebSocket = new FakeWebSocket();

    const host = new RemoteHostSystem({
        url: 'ws://127.0.0.1:8080/ws/system?token=test-token',
        webSocketFactory: () => fakeWs,
        reconnect: false,
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
            expect(fakeWs.readyState).toBe(3);
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
                const fakeWs = new FakeWebSocket();
                const host = new RemoteHostSystem({
                    webSocketFactory: (url) => {
                        connectedUrl = url;
                        return fakeWs;
                    },
                    reconnect: false,
                });

                expect(connectedUrl).toBe('wss://code.example.com:8443/ws/system?token=browser-token');
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
                if (msg.method === 'fs.readFile') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { content: storedBase64 },
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
                if (msg.method === 'fs.readFile') {
                    fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { content: storedBase64 } });
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
                if (msg.method === 'fs.readFile') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { content: storedBase64 },
                    });
                }
            });

            await host.fs.writeBinaryFile('/mock/repo/bin.dat', binaryPayload);
            const readBack = await host.fs.readBinaryFile('/mock/repo/bin.dat');
            expect(Array.from(readBack)).toEqual(Array.from(binaryPayload));

            host.dispose();
        });

        it('maps missing file error to HostSystemError with code ENOENT', async () => {
            const { host, fakeWs } = setupRemoteHost();
            await host.ready;

            fakeWs.onClientRequest((msg) => {
                if (msg.method === 'fs.readFile') {
                    fakeWs.simulateMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        error: {
                            code: RPC_CODE_INTERNAL_ERROR,
                            message: 'ENOENT: no such file or directory: /mock/repo/missing.txt',
                            data: { code: 'ENOENT' },
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
            let currentWs = new FakeWebSocket();
            let subIdCounter = 0;
            const unwatchCalls: string[] = [];

            const host = new RemoteHostSystem({
                url: 'ws://127.0.0.1:8080/ws/system?token=test-token',
                webSocketFactory: () => {
                    const ws = new FakeWebSocket();
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
                if (msg.method === 'fs.readFile') {
                    fakeWs.simulateMessage({ jsonrpc: '2.0', id: msg.id, result: { content: storedBase64 } });
                }
            });

            await host.fs.writeTextFile('/mock/repo/unicode.txt', unicodeText);
            const retrieved = await host.fs.readTextFile('/mock/repo/unicode.txt');
            expect(retrieved).toBe(unicodeText);

            host.dispose();
        });

        it('times out requests when daemon does not respond', async () => {
            const fakeWs: FakeWebSocket = new FakeWebSocket();
            const host = new RemoteHostSystem({
                url: 'ws://127.0.0.1:8080/ws/system?token=test-token',
                webSocketFactory: () => fakeWs,
                requestTimeoutMs: 50,
                reconnect: false,
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

        it('rejects ready promise when webSocketFactory throws synchronously', async () => {
            const host = new RemoteHostSystem({
                url: 'ws://invalid-url',
                webSocketFactory: () => {
                    throw new Error('CSP blocked');
                },
                reconnect: false,
            });

            await expect(host.ready).rejects.toThrow('CSP blocked');
            host.dispose();
        });

        it('rejects ready promise when reconnection fails and stops', async () => {
            const fakeWs = new FakeWebSocket();
            const host = new RemoteHostSystem({
                url: 'ws://127.0.0.1:8080/ws/system?token=test-token',
                webSocketFactory: () => fakeWs,
                reconnect: false,
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
            let currentWs = new FakeWebSocket();
            let connectionCount = 0;

            const host = new RemoteHostSystem({
                url: 'ws://127.0.0.1:8080/ws/system?token=test-token',
                webSocketFactory: () => {
                    connectionCount++;
                    const ws = new FakeWebSocket();
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
            expect(fakeWs.readyState).toBe(3); // CLOSED

            await expect(host.fs.exists('/mock/repo/after.txt')).rejects.toThrow('RemoteHostSystem is disposed');
        });
    });
});
