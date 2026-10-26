/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TrackableProcess {
    readonly pid?: number;
    readonly killed?: boolean;
    readonly exitCode?: number | null;
    readonly signalCode?: string | null;
    kill?(signal?: string | number): boolean;
}

export interface ProcessExecOptions {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly timeout?: number;
    readonly signal?: AbortSignal;
    readonly maxBuffer?: number;
    readonly onSpawn?: (proc: TrackableProcess) => void;
}

export interface ProcessResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
}

export class ProcessExitError extends Error {
    constructor(
        message: string,
        public readonly exitCode: number,
        public readonly stdout: string,
        public readonly stderr: string,
    ) {
        super(message);
        this.name = 'ProcessExitError';
    }
}

export type HelperScriptName = 'batch-diff' | 'batch-edit' | 'conflict-capture';

/** Placeholder in {@link ScratchExecRequest.args} replaced by the host with the created scratch directory. */
export const SCRATCH_DIR_TOKEN = '{{scratchDir}}';
/** Placeholder in {@link ScratchExecRequest.args} replaced by the host with the resolved helper script path. */
export const HELPER_SCRIPT_TOKEN = '{{helperScript}}';

/**
 * Describes a process run that needs a fresh scratch directory. The host performs
 * mkdtemp + mkdir(subdirs) + helper script resolution + exec + marker check as a
 * single operation so remote hosts pay one round trip instead of six.
 */
export interface ScratchExecRequest {
    readonly file: string;
    /** Arguments; occurrences of {@link SCRATCH_DIR_TOKEN} and {@link HELPER_SCRIPT_TOKEN} are substituted by the host. */
    readonly args: readonly string[];
    /** Prefix for the scratch directory name, created under the host's temp dir. */
    readonly scratchPrefix: string;
    /** Subdirectories (relative to the scratch dir) created before the process runs. */
    readonly subdirs: readonly string[];
    /** Helper script whose resolved path replaces {@link HELPER_SCRIPT_TOKEN}. */
    readonly helperScript?: HelperScriptName;
    /** Path relative to the scratch dir whose existence after exec is reported as `markerPresent`. */
    readonly completionMarker?: string;
    readonly options?: ProcessExecOptions;
}

/**
 * Result of {@link HostProcess.execFileInScratchDir}. Unlike `execFile`, a non-zero
 * exit does not reject: callers decide using `exitCode` and `markerPresent`.
 */
export interface ScratchExecResult extends ProcessResult {
    readonly scratchDir: string;
    readonly markerPresent: boolean;
}

export interface HostProcess {
    execFile(file: string, args: readonly string[], options?: ProcessExecOptions): Promise<ProcessResult>;
    execFileInScratchDir(request: ScratchExecRequest): Promise<ScratchExecResult>;
    getHelperScriptPath(scriptName: HelperScriptName): Promise<string>;
}

export interface FileStat {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    readonly mtimeMs?: number;
    readonly size?: number;
}

export interface HostFs {
    readonly tempDir: string;
    readTextFile(path: string): Promise<string>;
    /**
     * Reads several text files in one host call. Entries are `null` when the file
     * does not exist; any other failure rejects the whole call.
     */
    readTextFiles(paths: readonly string[]): Promise<(string | null)[]>;
    readBinaryFile(path: string): Promise<Uint8Array>;
    writeTextFile(path: string, content: string): Promise<void>;
    writeBinaryFile(path: string, content: Uint8Array): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    stat(path: string): Promise<FileStat>;
    lstat(path: string): Promise<FileStat>;
    readdir(path: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
    existsSync?(path: string): boolean;
    realpath(path: string): Promise<string>;
    realpathSync?(path: string): string;
    mkdtemp(prefix: string): Promise<string>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    unlink(path: string): Promise<void>;
}

export interface WatchEvent {
    readonly path: string;
    readonly type: 'create' | 'update' | 'delete';
}

export interface WatcherSubscription {
    unsubscribe(): Promise<void>;
}

export interface WatchOptions {
    readonly ignore?: readonly string[];
    readonly backend?: string;
}

export interface HostWatcher {
    watch(
        dirPath: string,
        callback: (err: Error | null, events: WatchEvent[]) => void,
        options?: WatchOptions,
    ): Promise<WatcherSubscription>;
}

export type HostPlatform = 'linux' | 'darwin' | 'win32';

export interface HostSystem {
    readonly process: HostProcess;
    readonly fs: HostFs;
    readonly watcher: HostWatcher;
    readonly platform: HostPlatform;
}
