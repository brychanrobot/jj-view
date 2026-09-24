/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import { type BackendType, subscribe } from '@parcel/watcher';
import path from 'pathe';
import { setRealpathSyncResolver } from '../uri-utils';
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
    type WatchEvent,
    type WatcherSubscription,
    type WatchOptions,
} from './host-system';

export class NodeHostProcess implements HostProcess {
    async execFile(file: string, args: readonly string[], options?: ProcessExecOptions): Promise<ProcessResult> {
        return new Promise<ProcessResult>((resolve, reject) => {
            const cpOptions: cp.ExecFileOptions = {
                cwd: options?.cwd,
                env: options?.env ? { ...process.env, ...options.env } : process.env,
                timeout: options?.timeout,
                signal: options?.signal,
                maxBuffer: options?.maxBuffer ?? 100 * 1024 * 1024,
            };

            const child = cp.execFile(file, [...args], cpOptions, (err, stdout, stderr) => {
                const stdoutStr = stdout?.toString() ?? '';
                const stderrStr = stderr?.toString() ?? '';
                if (err) {
                    const exitCode = typeof err.code === 'number' ? err.code : 1;
                    reject(new ProcessExitError(err.message, exitCode, stdoutStr, stderrStr));
                    return;
                }
                resolve({
                    stdout: stdoutStr,
                    stderr: stderrStr,
                    exitCode: 0,
                });
            });

            if (options?.onSpawn) {
                options.onSpawn(child);
            }
        });
    }

    async getHelperScriptPath(scriptName: HelperScriptName): Promise<string> {
        const isWin = process.platform === 'win32';
        const fileName = isWin ? `${scriptName}.bat` : `${scriptName}.sh`;
        const candidates = [
            path.join(__dirname, '..', 'scripts', fileName),
            path.join(__dirname, '..', '..', 'scripts', fileName),
            path.join(__dirname, '..', '..', '..', 'scripts', fileName),
            path.join(process.cwd(), 'scripts', fileName),
        ];
        for (const candidate of candidates) {
            if (fsSync.existsSync(candidate)) {
                return candidate;
            }
        }
        throw new Error(
            `Helper script "${scriptName}" (${fileName}) not found in candidates: ${candidates.join(', ')}`,
        );
    }
}

export class NodeHostFs implements HostFs {
    public readonly tempDir: string = os.tmpdir();

    async readTextFile(filePath: string): Promise<string> {
        return fsPromises.readFile(filePath, 'utf8');
    }

    async readBinaryFile(filePath: string): Promise<Uint8Array> {
        const buf = await fsPromises.readFile(filePath);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }

    async writeTextFile(filePath: string, content: string): Promise<void> {
        await fsPromises.writeFile(filePath, content, 'utf8');
    }

    async writeBinaryFile(filePath: string, content: Uint8Array): Promise<void> {
        await fsPromises.writeFile(filePath, content);
    }

    async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
        await fsPromises.mkdir(dirPath, options);
    }

    async stat(targetPath: string): Promise<FileStat> {
        const s = await fsPromises.stat(targetPath);
        return {
            isFile: () => s.isFile(),
            isDirectory: () => s.isDirectory(),
            isSymbolicLink: () => s.isSymbolicLink(),
            mtimeMs: s.mtimeMs,
            size: s.size,
        };
    }

    async lstat(targetPath: string): Promise<FileStat> {
        const s = await fsPromises.lstat(targetPath);
        return {
            isFile: () => s.isFile(),
            isDirectory: () => s.isDirectory(),
            isSymbolicLink: () => s.isSymbolicLink(),
            mtimeMs: s.mtimeMs,
            size: s.size,
        };
    }

    async readdir(dirPath: string): Promise<string[]> {
        return fsPromises.readdir(dirPath);
    }

    async exists(targetPath: string): Promise<boolean> {
        try {
            await fsPromises.stat(targetPath);
            return true;
        } catch {
            return false;
        }
    }

    existsSync(targetPath: string): boolean {
        return fsSync.existsSync(targetPath);
    }

    async realpath(targetPath: string): Promise<string> {
        return fsPromises.realpath(targetPath);
    }

    realpathSync(targetPath: string): string {
        return fsSync.realpathSync(targetPath);
    }

    async mkdtemp(prefix: string): Promise<string> {
        const fullPrefix = path.isAbsolute(prefix) ? prefix : path.join(this.tempDir, prefix);
        return fsPromises.mkdtemp(fullPrefix);
    }

    async rm(targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
        await fsPromises.rm(targetPath, options);
    }

    async unlink(targetPath: string): Promise<void> {
        await fsPromises.unlink(targetPath);
    }
}

export class NodeHostWatcher implements HostWatcher {
    async watch(
        dirPath: string,
        callback: (err: Error | null, events: WatchEvent[]) => void,
        options?: WatchOptions,
    ): Promise<WatcherSubscription> {
        const parcelOptions: { ignore?: string[]; backend?: BackendType } = {};
        if (options?.ignore) {
            parcelOptions.ignore = [...options.ignore];
        }
        if (options?.backend) {
            parcelOptions.backend = options.backend as BackendType;
        }
        const subscription = await subscribe(
            dirPath,
            (err, events) => {
                if (err) {
                    callback(err, []);
                    return;
                }
                const mappedEvents: WatchEvent[] = events.map((e) => ({
                    path: e.path,
                    type: e.type,
                }));
                callback(null, mappedEvents);
            },
            parcelOptions,
        );

        let unsubscribed = false;
        return {
            unsubscribe: async () => {
                if (unsubscribed) {
                    return;
                }
                unsubscribed = true;
                try {
                    await Promise.race([
                        subscription.unsubscribe(),
                        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
                    ]);
                } catch {
                    // Ignore errors during unsubscribe
                }
            },
        };
    }
}

export class NodeHostSystem implements HostSystem {
    public readonly process: HostProcess;
    public readonly fs: HostFs;
    public readonly watcher: HostWatcher;
    public readonly platform: HostPlatform;

    constructor(options?: {
        process?: HostProcess;
        fs?: HostFs;
        watcher?: HostWatcher;
    }) {
        this.process = options?.process ?? new NodeHostProcess();
        this.fs = options?.fs ?? new NodeHostFs();
        this.watcher = options?.watcher ?? new NodeHostWatcher();
        const rawPlatform = process.platform;
        this.platform = rawPlatform === 'win32' || rawPlatform === 'darwin' ? rawPlatform : 'linux';
        setRealpathSyncResolver(fsSync.realpathSync);
    }
}
