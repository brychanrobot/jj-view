/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { z } from 'zod';
import { AsyncCache } from '../utils/async-cache';
import { getErrorMessage } from '../utils/error-utils';
import { type DiffHunkRange, parseDiffHunks, parseMultiFileDiffHunks } from '../utils/line-drift';
import { LruCache } from '../utils/lru-cache';
import { type LoggerChannel, NO_OP_LOGGER } from '../utils/output-channel';
import type { UploadedRevisionFile } from './code-forge-provider';
import {
    HELPER_SCRIPT_TOKEN,
    type HostPlatform,
    type HostSystem,
    type ProcessExecOptions,
    ProcessExitError,
    type ProcessResult,
    SCRATCH_DIR_TOKEN,
    type ScratchExecRequest,
    type ScratchExecResult,
    type TrackableProcess,
} from './host/host-system';
import { NodeHostSystem } from './host/node-host-system';
import type { IJjTrackedProcess, JjProcessTracker } from './jj-process-tracker';
import {
    type ConflictedFileEntry,
    createJjOutputSchemas,
    type DiffStatEntry,
    JjBookmarkSchema,
    type JjFileChange,
    type JjFileChangeWithStats,
    JjWorkspaceSchema,
} from './jj-schemas';
import {
    BOOKMARK_SCHEMA,
    buildDiffFileSchema,
    buildLogTemplate,
    CHANGE_ID_EXPR,
    LOG_ENTRY_SCHEMA,
    WORKSPACE_SCHEMA,
} from './jj-template-builder';
import type { JjBookmark, JjLogEntry, JjStatusEntry, JjWorkspace } from './jj-types';
import type { SelectionRange } from './patch-helper';
import * as PatchHelper from './patch-helper';
import {
    isWindowsStylePath,
    normalizeRepoSeparators,
    pathDirname,
    pathIsAbsolute,
    pathJoin,
    pathNormalize,
    pathRelative,
    pathResolve,
    trimSeparators,
    unquoteGitPath,
} from './path-utils';
import { isInsideRelativePath, normalizeDriveLetter, resolvePathAgainstRealRootAsync } from './uri-utils';

export { NO_OP_LOGGER };

export interface GitCommitDetails {
    description: string;
    files: Record<string, UploadedRevisionFile>;
}

const HEX_COMMIT_PATTERN = /^[0-9a-fA-F]{4,64}$/;

function parseGitRawFiles(
    tokens: string[],
    startIndex: number,
    platform?: HostPlatform | string,
): Record<string, UploadedRevisionFile> {
    const files: Record<string, UploadedRevisionFile> = {};
    let idx = startIndex;
    while (idx < tokens.length) {
        const header = tokens[idx].replace(/^(?:\r?\n)+/, '');
        if (!header?.startsWith(':')) {
            idx++;
            continue;
        }
        const match = /^:\d+\s+\d+\s+[0-9a-fA-F]+\s+([0-9a-fA-F]+)\s+([A-Z])(?:\d+)?$/.exec(header);
        if (!match) {
            idx++;
            continue;
        }
        const [, rawNewSha, statusLetter] = match;
        const isZeroSha = /^0+$/.test(rawNewSha);
        const newSha = statusLetter === 'D' || isZeroSha ? undefined : rawNewSha;

        if (statusLetter === 'R' || statusLetter === 'C') {
            const oldPath = tokens[idx + 1];
            const newPath = tokens[idx + 2];
            if (oldPath !== undefined && newPath !== undefined) {
                files[normalizeRepoSeparators(newPath, platform)] = {
                    status: statusLetter,
                    oldPath: normalizeRepoSeparators(oldPath, platform),
                    newSha,
                };
            }
            idx += 3;
            continue;
        }

        const filePath = tokens[idx + 1];
        if (filePath !== undefined) {
            files[normalizeRepoSeparators(filePath, platform)] = {
                status: statusLetter,
                newSha,
            };
        }
        idx += 2;
    }
    return files;
}

export interface JjLogOptions {
    revision?: string;
    limit?: number;
    omitChanges?: boolean;
    includeNearestVisibleAncestors?: boolean;
}

/**
 * Target placement strategy when rebasing commits:
 * - 'onto': Rebase onto target destination(s) using canonical `-o` (`--onto`).
 * - 'after': Insert after target commit(s) using `-A` (`--insert-after`).
 * - 'before': Insert before target commit(s) using `-B` (`--insert-before`).
 */
export type RebasePlacement = 'onto' | 'before' | 'after';

/**
 * Options configuring a rebase operation.
 */
export interface RebaseOptions {
    /** Target revision(s) or revsets. */
    target: string | string[];
    /** Placement relative to target. Defaults to 'onto'. */
    placement?: RebasePlacement;
    /** Whether to rebase a single revision ('revision' / `-r`) or the source and its descendants ('source' / `-s`). Defaults to 'source'. */
    mode?: 'source' | 'revision';
}

// Safety timeout: if a mutation takes longer than this, unblock file watcher
const ONE_MINUTE = 60_000;
const MUTATION_TIMEOUT_MS = ONE_MINUTE;
const READ_TIMEOUT_MS = 2 * ONE_MINUTE;
const UPLOAD_TIMEOUT_MS = 6 * ONE_MINUTE;

declare global {
    var __JJ_VIEW_COMMAND_HOOK__: ((command: string, args: string[], durationMs: number) => void) | undefined;
}

export type JjServiceConfigProvider<S = never> = <T>(key: string, defaultValue?: T, scope?: S) => T | undefined;

export interface JjServiceOptions {
    binaryPath?: string;
    getConfig?: JjServiceConfigProvider;
    processTracker?: JjProcessTracker;
    system?: HostSystem;
}

export interface JjRunOptions {
    timeout?: number;
    cwd?: string;
    trim?: boolean;
    useCachedSnapshot?: boolean;
    isMutation?: boolean;
    label?: string;
}

function escapeFilesetString(relPath: string): string {
    let escaped = '';
    for (const ch of relPath) {
        const code = ch.charCodeAt(0);
        if (ch === '\\') {
            escaped += '\\\\';
        } else if (ch === '"') {
            escaped += '\\"';
        } else if (ch === '\t') {
            escaped += '\\t';
        } else if (ch === '\r') {
            escaped += '\\r';
        } else if (ch === '\n') {
            escaped += '\\n';
        } else if (ch === '\0') {
            escaped += '\\0';
        } else if (code < 0x20 || code === 0x7f) {
            escaped += `\\x${code.toString(16).padStart(2, '0')}`;
        } else {
            escaped += ch;
        }
    }
    return escaped;
}

/**
 * Formats a workspace-relative path prefix (file or directory) as a JJ `root:"..."` fileset literal
 * so backslashes, quotes, and fileset metacharacters are treated as literal path characters.
 */
export function formatRootFileset(relPath: string): string {
    return `root:"${escapeFilesetString(relPath)}"`;
}

/**
 * Formats a workspace-relative file path as an exact JJ `root-file:"..."` fileset literal
 * so fileset metacharacters (`:`, `*`, `~`, parentheses) and leading dashes are treated as literal path characters.
 */
export function formatRootFileFileset(relPath: string): string {
    return `root-file:"${escapeFilesetString(relPath)}"`;
}

export class JjService {
    public binaryPath: string;
    public processTracker?: JjProcessTracker;
    public readonly system: HostSystem;
    private readonly _pathPlatform: HostPlatform | string;
    private readonly _schemas: ReturnType<typeof createJjOutputSchemas>;
    private readonly _getConfig?: JjServiceConfigProvider;
    private _writeOperationCount = 0;
    private _lastWriteTime = 0;
    private _operationTimeouts = new Map<number, NodeJS.Timeout>();
    private _nextOpId = 0;
    private static readonly MAX_LOG_ENTRY_CACHE_KEYS = 4000;
    private _cacheEpoch = 0;
    private readonly _logEntryCache = new Map<string, JjLogEntry>();
    private _logRevsetPromise: Promise<string> | undefined;
    private readonly _diffCache: AsyncCache<string, { tempDir: string; expires: number }>;
    private readonly _diffContentCache = new Map<string, Map<string, { left: string; right: string }>>();
    private readonly _diffBinaryCache = new Map<string, Map<string, { left: Uint8Array; right: Uint8Array }>>();
    private readonly _changesCache = new AsyncCache<string, JjStatusEntry[]>({
        clone: (entries) => entries.map((e) => ({ ...e })),
    });
    private readonly _gitBlobContentCache = new LruCache<string, string>({ maxEntries: 200 });
    private readonly _gitCommitDetailsCache = new LruCache<string, GitCommitDetails>({ maxEntries: 200 });
    private readonly _gitRangeFilesCache = new LruCache<string, Record<string, UploadedRevisionFile>>({
        maxEntries: 200,
    });
    private _mutationMutex: Promise<void> = Promise.resolve();

    constructor(
        public readonly workspaceRoot: string,
        public readonly logger: LoggerChannel = NO_OP_LOGGER,
        options?: JjServiceOptions,
    ) {
        this.binaryPath = options?.binaryPath ?? 'jj';
        this._getConfig = options?.getConfig;
        this.processTracker = options?.processTracker;
        this.system = options?.system ?? new NodeHostSystem();
        this._pathPlatform =
            this.system.platform === 'win32' || isWindowsStylePath(this.workspaceRoot) ? 'win32' : this.system.platform;
        this._schemas = createJjOutputSchemas(this._pathPlatform);
        this._diffCache = new AsyncCache<string, { tempDir: string; expires: number }>({
            onEvict: (entry) => this.system.fs.rm(entry.tempDir, { recursive: true, force: true }).catch(() => {}),
        });
    }

    private getReadTimeoutMs(): number {
        if (this._getConfig) {
            const seconds = this._getConfig<number>('readTimeoutSeconds', 120);
            if (typeof seconds === 'number' && seconds > 0) {
                return seconds * 1000;
            }
        }
        return READ_TIMEOUT_MS;
    }

    private _repoRoot?: string;
    private _repoRootPromise?: Promise<string>;
    /**
     * Resolves `jj root` for this service's workspaceRoot. Concurrent callers
     * share one spawn: the result only depends on cwd, which is fixed per
     * instance. Different instances (different cwds) still spawn separately.
     */
    async getRepoRoot(): Promise<string> {
        if (this._repoRoot !== undefined) {
            return this._repoRoot;
        }
        if (this._repoRootPromise) {
            return this._repoRootPromise;
        }
        const promise = this.run('root', [], { useCachedSnapshot: true, label: 'getRepoRoot' });
        this._repoRootPromise = promise;
        try {
            const root = await promise;
            this._repoRoot = root;
            return root;
        } finally {
            if (this._repoRootPromise === promise) {
                this._repoRootPromise = undefined;
            }
        }
    }

    /**
     * Resolves the path to the repository's store (usually .jj/repo).
     * Handles both default workspaces (where it's a directory) and secondary
     * workspaces (where it's a file pointing to the main repo's store).
     */
    async getRepoStorePath(): Promise<string> {
        const workspaceRoot = await this.getRepoRoot();
        const platform = this._pathPlatform;
        const repoPath = pathJoin([workspaceRoot, '.jj', 'repo'], platform);
        try {
            const stats = await this.system.fs.lstat(repoPath);
            if (stats.isFile()) {
                const content = await this.system.fs.readTextFile(repoPath);
                return pathResolve([pathDirname(repoPath, platform), content.trim()], platform);
            }
            return await this.system.fs.realpath(repoPath);
        } catch {
            return repoPath;
        }
    }

    /**
     * Finds the root directory of the "main" workspace (the one containing the repo store).
     */
    async getMainWorkspaceRoot(): Promise<string> {
        const storePath = await this.getRepoStorePath();
        const platform = this._pathPlatform;
        // The store is typically <main-root>/.jj/repo.
        // Parent 1: <main-root>/.jj
        // Parent 2: <main-root>
        return pathDirname(pathDirname(storePath, platform), platform);
    }

    private _gitRoot?: string | null;
    private _gitRootPromise?: Promise<string | null>;
    async getGitRoot(): Promise<string | null> {
        if (this._gitRoot !== undefined) {
            return this._gitRoot;
        }
        if (this._gitRootPromise) {
            return this._gitRootPromise;
        }
        let promise: Promise<string | null> | undefined;
        promise = (async () => {
            try {
                const root = await this.run('git', ['root'], { useCachedSnapshot: true, label: 'getGitRoot' });
                if (this._gitRootPromise === promise) {
                    this._gitRoot = root;
                }
                return root;
            } catch {
                if (this._gitRootPromise === promise) {
                    this._gitRoot = null;
                }
                return null;
            } finally {
                if (this._gitRootPromise === promise) {
                    this._gitRootPromise = undefined;
                }
            }
        })();
        this._gitRootPromise = promise;
        return this._gitRootPromise;
    }

    get hasActiveWriteOps(): boolean {
        return this._writeOperationCount > 0;
    }

    get writeOpCount(): number {
        return this._writeOperationCount;
    }

    get lastWriteTime(): number {
        return this._lastWriteTime;
    }

    static isIndexLockError(error: unknown): boolean {
        const message = getErrorMessage(error);
        return message.includes('index.lock') || message.includes('Could not acquire lock');
    }

    private _workspaceReal?: string;
    private _workspaceRealPromise?: Promise<string>;
    private _realRoots?: { repoReal: string; workspaceReal: string };
    private _realRootsPromise?: Promise<{ repoReal: string; workspaceReal: string }>;

    /**
     * Resolves and caches the canonical `realpath` of `workspaceRoot`, falling
     * back to `workspaceRoot` without caching if resolution fails.
     */
    async getWorkspaceReal(): Promise<string> {
        if (this._workspaceReal !== undefined) {
            return this._workspaceReal;
        }
        if (this._workspaceRealPromise) {
            return this._workspaceRealPromise;
        }
        let promise: Promise<string> | undefined;
        promise = (async () => {
            try {
                const real = await this.system.fs.realpath(this.workspaceRoot);
                this._workspaceReal = real;
                return real;
            } catch {
                return this.workspaceRoot;
            } finally {
                if (this._workspaceRealPromise === promise) {
                    this._workspaceRealPromise = undefined;
                }
            }
        })();
        this._workspaceRealPromise = promise;
        return promise;
    }

    private async getRealRoots(): Promise<{ repoReal: string; workspaceReal: string }> {
        if (this._realRoots) {
            return this._realRoots;
        }
        if (this._realRootsPromise) {
            return this._realRootsPromise;
        }
        let promise: Promise<{ repoReal: string; workspaceReal: string }> | undefined;
        promise = (async () => {
            try {
                const [repoRoot, workspaceReal] = await Promise.all([this.getRepoRoot(), this.getWorkspaceReal()]);
                let repoReal = repoRoot;
                let repoRealOk = false;
                try {
                    repoReal = await this.system.fs.realpath(repoRoot);
                    repoRealOk = true;
                } catch {
                    repoReal = repoRoot;
                }
                const resolvedWorkspaceReal = this._workspaceReal;
                if (repoRealOk && resolvedWorkspaceReal !== undefined) {
                    const resolvedRoots = { repoReal, workspaceReal: resolvedWorkspaceReal };
                    this._realRoots = resolvedRoots;
                    return resolvedRoots;
                }
                return { repoReal, workspaceReal };
            } finally {
                if (this._realRootsPromise === promise) {
                    this._realRootsPromise = undefined;
                }
            }
        })();
        this._realRootsPromise = promise;
        return promise;
    }

    private async workspaceRelativeToRepoRelative(workspaceRelPath: string): Promise<string> {
        const platform = this._pathPlatform;
        const repoRoot = await this.getRepoRoot();
        const normRepoRoot = normalizeDriveLetter(pathNormalize(repoRoot, platform));
        const normWorkspaceRoot = normalizeDriveLetter(pathNormalize(this.workspaceRoot, platform));
        if (normRepoRoot === normWorkspaceRoot) {
            return pathNormalize(workspaceRelPath, platform);
        }
        const { repoReal, workspaceReal } = await this.getRealRoots();
        const normRepoReal = normalizeDriveLetter(pathNormalize(repoReal, platform));
        const normWorkspaceReal = normalizeDriveLetter(pathNormalize(workspaceReal, platform));
        if (normRepoReal === normWorkspaceReal) {
            return pathNormalize(workspaceRelPath, platform);
        }
        const repoToWorkspace = pathRelative(normRepoReal, normWorkspaceReal, platform);
        return pathNormalize(pathJoin([repoToWorkspace, workspaceRelPath], platform), platform);
    }

    private async resolveRelativeToRealRoot(filePath: string, realRoot: string): Promise<string> {
        const platform = this._pathPlatform;
        const resolution = await resolvePathAgainstRealRootAsync(filePath, realRoot, this.system.fs, platform);
        if (resolution?.inside) {
            return resolution.relativePath;
        }
        const fileReal = resolution?.resolvedPath ?? filePath;
        return pathNormalize(
            pathRelative(
                normalizeDriveLetter(pathNormalize(realRoot, platform)),
                normalizeDriveLetter(fileReal),
                platform,
            ),
            platform,
        );
    }

    private async toRelative(filePath: string): Promise<string> {
        const platform = this._pathPlatform;
        if (!pathIsAbsolute(filePath, platform)) {
            return filePath;
        }
        const directRel = pathRelative(
            normalizeDriveLetter(this.workspaceRoot),
            normalizeDriveLetter(filePath),
            platform,
        );
        if (isInsideRelativePath(directRel, platform)) {
            return pathNormalize(directRel, platform);
        }
        const workspaceReal = await this.getWorkspaceReal();
        return this.resolveRelativeToRealRoot(filePath, workspaceReal);
    }

    private async toRepoRelative(filePath: string): Promise<string> {
        const platform = this._pathPlatform;
        if (!pathIsAbsolute(filePath, platform)) {
            return this.workspaceRelativeToRepoRelative(filePath);
        }

        const directWorkspaceRel = pathRelative(
            normalizeDriveLetter(this.workspaceRoot),
            normalizeDriveLetter(filePath),
            platform,
        );
        if (isInsideRelativePath(directWorkspaceRel, platform)) {
            return this.workspaceRelativeToRepoRelative(directWorkspaceRel);
        }

        const { repoReal } = await this.getRealRoots();
        const normRepoReal = normalizeDriveLetter(pathNormalize(repoReal, platform));
        const rel = pathRelative(normRepoReal, normalizeDriveLetter(filePath), platform);
        if (isInsideRelativePath(rel, platform)) {
            return pathNormalize(rel, platform);
        }

        return this.resolveRelativeToRealRoot(filePath, repoReal);
    }

    /**
     * Resolves a file path (absolute or workspace-relative) to a canonical repo-relative path,
     * or `undefined` if the path lies outside the repository.
     */
    async resolveRepoRelativePath(filePath: string): Promise<string | undefined> {
        const platform = this._pathPlatform;
        const rel = await this.toRepoRelative(filePath);
        if (!isInsideRelativePath(rel, platform)) {
            return undefined;
        }
        const normalized = normalizeRepoSeparators(trimSeparators(rel, platform), platform);
        if (!normalized || normalized === '.') {
            return '';
        }
        return normalized;
    }

    private getToolConfigArgs(toolName: string, scriptPath: string, argsTemplate: string[]): string[] {
        const isWin = this.system.platform === 'win32';
        const normalizedScriptPath = pathNormalize(scriptPath, this.system.platform);

        // JSON.stringify produces valid TOML double-quoted strings, preserving backslashes on POSIX
        const quotedArgs = argsTemplate.map((arg) => JSON.stringify(arg));

        if (isWin) {
            // On Windows, we must use cmd /c to execute .bat files correctly from jj
            const escapedScriptPath = normalizedScriptPath.replace(/\//g, '\\\\');
            return [
                `--config=merge-tools.${toolName}.program="cmd"`,
                `--config=merge-tools.${toolName}.merge-args=["/s", "/c", "${escapedScriptPath}", ${quotedArgs.join(', ')}]`,
                `--config=merge-tools.${toolName}.edit-args=["/s", "/c", "${escapedScriptPath}", ${quotedArgs.join(', ')}]`,
            ];
        } else {
            return [
                `--config=merge-tools.${toolName}.program=${JSON.stringify(normalizedScriptPath)}`,
                `--config=merge-tools.${toolName}.merge-args=[${quotedArgs.join(', ')}]`,
                `--config=merge-tools.${toolName}.edit-args=[${quotedArgs.join(', ')}]`,
            ];
        }
    }

    // POLICY: This method is intentionally private. Do not expose it publicly.
    // Instead, create specific methods for each operation to ensure strictly typed usage
    // and prevent arbitrary command execution.
    private async run(command: string, args: string[], options: JjRunOptions = {}): Promise<string> {
        if (options.isMutation) {
            return this.runMutation(() => this.runInternal(command, args, options));
        }
        return this.runInternal(command, args, options);
    }

    private buildGlobalArgs(options: JjRunOptions): string[] {
        const globalArgs = [
            '--config',
            'ui.log-word-wrap=false',
            '--config',
            'ui.color="never"',
            '--config',
            'ui.paginate="never"',
            '--config',
            'ui.diff-instructions=false',
        ];
        if (options.useCachedSnapshot) {
            globalArgs.push('--ignore-working-copy');
        }
        return globalArgs;
    }

    private async runInternal(command: string, args: string[], options: JjRunOptions = {}): Promise<string> {
        const result = await this.execTracked(command, args, options, (allArgs, execOptions) =>
            this.system.process.execFile(this.binaryPath, allArgs, execOptions),
        );
        const shouldTrim = options.trim !== false;
        return shouldTrim ? result.stdout.trim() : result.stdout;
    }

    /**
     * Runs a jj command that needs a fresh scratch directory (created by the host) and
     * a helper script path, as a single host operation. `scratch.completionMarker`
     * decides success: helper scripts intentionally exit non-zero to abort the jj
     * operation after capturing output, so exit code alone is not meaningful.
     */
    private async runInScratchDir(
        command: string,
        args: string[],
        scratch: Omit<ScratchExecRequest, 'file' | 'args' | 'options'>,
        options: JjRunOptions = {},
    ): Promise<ScratchExecResult> {
        return this.execTracked(command, args, options, async (allArgs, execOptions) => {
            const result = await this.system.process.execFileInScratchDir({
                ...scratch,
                file: this.binaryPath,
                args: allArgs,
                options: execOptions,
            });
            if (result.exitCode === 0 || result.markerPresent) {
                return result;
            }
            await this.system.fs.rm(result.scratchDir, { recursive: true, force: true }).catch(() => {});
            throw new ProcessExitError(
                `Process ${this.binaryPath} failed with exit code ${result.exitCode}`,
                result.exitCode,
                result.stdout,
                result.stderr,
            );
        });
    }

    private async execTracked<T extends ProcessResult>(
        command: string,
        args: string[],
        options: JjRunOptions,
        invoke: (allArgs: string[], execOptions: ProcessExecOptions) => Promise<T>,
    ): Promise<T> {
        const opId = this._nextOpId++;

        const start = performance.now();
        const allArgs = [...this.buildGlobalArgs(options), command, ...args];
        const prefix = options.label ? `[${options.label}] ` : '';
        const fullCommandStr = `jj ${[command, ...args].join(' ')}`;
        const logSummaryStr = `${prefix}jj ${[command, ...args].slice(0, 2).join(' ')}${[command, ...args].length > 2 ? '...' : ''}`;

        const isMutation = !!options.isMutation;
        const maxDuration = options.timeout ?? (isMutation ? MUTATION_TIMEOUT_MS : this.getReadTimeoutMs());

        let timeout: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        let trackedProcess: IJjTrackedProcess | undefined;
        let spawnedProc: TrackableProcess | undefined;

        const abortController = new AbortController();
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
                timedOut = true;
                const opType = isMutation ? 'Mutation operation' : 'Read operation';
                const timeoutMsg = `${opType} timed out after ${maxDuration / 1000}s`;
                this.logger.warn(`[${timeoutMsg}] ${logSummaryStr}`);
                const timeoutError = new Error(timeoutMsg);
                trackedProcess?.finish('timed_out', timeoutError);
                try {
                    spawnedProc?.kill?.();
                } catch {}
                abortController.abort();
                reject(timeoutError);
            }, maxDuration);
        });

        if (isMutation && timeout !== undefined) {
            this._operationTimeouts.set(opId, timeout);
        }

        const isWin = this.system.platform === 'win32';
        const noOpEditor = isWin ? 'cmd.exe /c exit 0' : 'true';

        try {
            const execOptions: ProcessExecOptions = {
                cwd: options.cwd ?? this.workspaceRoot,
                env: {
                    JJ_EDITOR: noOpEditor,
                    EDITOR: noOpEditor,
                    JJ_VIEW_EXTENSION: '1',
                },
                maxBuffer: 100 * 1024 * 1024,
                timeout: maxDuration,
                signal: abortController.signal,
                onSpawn: (childProcess) => {
                    spawnedProc = childProcess;
                    trackedProcess = this.processTracker?.startTrackingProcess({
                        command: fullCommandStr,
                        args: allArgs,
                        status: 'running',
                        label: options.label,
                        childProcess,
                    });
                },
            };

            const result = await Promise.race([invoke(allArgs, execOptions), timeoutPromise]);
            const duration = performance.now() - start;
            if (globalThis.__JJ_VIEW_COMMAND_HOOK__) {
                globalThis.__JJ_VIEW_COMMAND_HOOK__(command, args, duration);
            }
            const cachedInfo = options.useCachedSnapshot ? ' (cached)' : '';
            this.logger.debug(`[${duration.toFixed(0)}ms]${cachedInfo} ${prefix}${fullCommandStr}`);
            trackedProcess?.finish('completed', undefined, result.stdout, result.stderr);

            if (isMutation) {
                await this.clearCache().catch((err) => this.logger.warn(`Warning: failed to clear cache: ${err}`));
            }

            return result;
        } catch (err: unknown) {
            if (timedOut) {
                throw new Error(
                    `${isMutation ? 'Mutation operation' : 'Read operation'} timed out after ${maxDuration / 1000}s`,
                );
            }
            const duration = performance.now() - start;
            if (globalThis.__JJ_VIEW_COMMAND_HOOK__) {
                globalThis.__JJ_VIEW_COMMAND_HOOK__(command, args, duration);
            }
            const cachedInfo = options.useCachedSnapshot ? ' (cached)' : '';
            this.logger.debug(`[${duration.toFixed(0)}ms]${cachedInfo} ${prefix}${fullCommandStr}`);

            let formattedErr: Error;
            if (err instanceof ProcessExitError) {
                const combined: string[] = [];
                const outStr = err.stdout.trim();
                const errStr = err.stderr.trim();
                if (outStr) {
                    combined.push(outStr);
                }
                if (errStr) {
                    combined.push(errStr);
                }
                formattedErr = new Error(combined.length > 0 ? combined.join('\n\n') : err.message);
                trackedProcess?.finish('failed', formattedErr, err.stdout, err.stderr, err.exitCode);
            } else {
                formattedErr = err instanceof Error ? err : new Error(String(err));
                trackedProcess?.finish('failed', formattedErr);
            }
            throw formattedErr;
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
            if (isMutation) {
                this._operationTimeouts.delete(opId);
            }
        }
    }

    async getBookmarks(options: { revision?: string } = {}): Promise<JjBookmark[]> {
        const template = buildLogTemplate(BOOKMARK_SCHEMA);
        const args = ['list', '-T', template];
        if (options.revision) {
            args.push('-r', options.revision);
        }
        const output = await this.run('bookmark', args, {
            useCachedSnapshot: true,
            label: 'getBookmarks',
        });
        return this._parseJsonLines(output, JjBookmarkSchema, 'getBookmarks');
    }

    async moveBookmark(name: string, toRevision: string): Promise<string> {
        return this.run('bookmark', ['set', name, '-r', toRevision, '--allow-backwards'], {
            isMutation: true,
            label: 'moveBookmark',
        });
    }

    async advanceBookmark(toRevision: string, names?: string[]): Promise<string> {
        const args = ['advance', '--to', toRevision];
        if (names && names.length > 0) {
            args.push(...names);
        }
        return this.run('bookmark', args, {
            isMutation: true,
            label: 'advanceBookmark',
        });
    }

    async deleteBookmark(name: string): Promise<string> {
        return this.run('bookmark', ['delete', name], {
            isMutation: true,
            label: 'deleteBookmark',
        });
    }

    private _setCachedLogEntry(key: string, entry: JjLogEntry): void {
        if (this._logEntryCache.has(key)) {
            this._logEntryCache.delete(key);
        } else if (this._logEntryCache.size >= JjService.MAX_LOG_ENTRY_CACHE_KEYS) {
            const oldestKey = this._logEntryCache.keys().next().value;
            if (oldestKey !== undefined) {
                this._logEntryCache.delete(oldestKey);
            }
        }
        this._logEntryCache.set(key, entry);
    }

    private _cloneLogEntry(entry: JjLogEntry): JjLogEntry {
        return {
            ...entry,
            author: { ...entry.author },
            committer: { ...entry.committer },
            parents: entry.parents.map((p) => ({ ...p })),
            bookmarks: entry.bookmarks.map((b) => ({ ...b })),
            tags: entry.tags ? [...entry.tags] : undefined,
            working_copies: entry.working_copies ? [...entry.working_copies] : undefined,
            nearest_visible_ancestors: entry.nearest_visible_ancestors
                ? [...entry.nearest_visible_ancestors]
                : undefined,
            changes: entry.changes ? entry.changes.map((c) => ({ ...c })) : undefined,
        };
    }

    async getLog(options: JjLogOptions = {}): Promise<JjLogEntry[]> {
        const { revision, limit, omitChanges, includeNearestVisibleAncestors } = options;

        if (revision && omitChanges && !includeNearestVisibleAncestors && (!limit || limit === 1)) {
            const cached = this._logEntryCache.get(revision);
            if (cached) {
                return [this._cloneLogEntry(cached)];
            }
        }

        let schema = LOG_ENTRY_SCHEMA;
        if (omitChanges) {
            schema = { ...LOG_ENTRY_SCHEMA };
            delete schema.changes;
        }

        const args = ['-T', buildLogTemplate(schema)];
        if (revision) {
            args.push('-r', revision);
        }

        if (limit !== undefined) {
            args.push('-n', limit.toString());
        }

        const epoch = this._cacheEpoch;
        // The nearest-ancestor search set needs the configured log revset when
        // no explicit revision is given. Start that lookup now so it overlaps
        // the main log query instead of adding a serial jj spawn afterwards.
        const searchSet =
            includeNearestVisibleAncestors && !revision ? this.getConfiguredLogRevset() : Promise.resolve(revision);
        const output = await this.run('log', args, { useCachedSnapshot: true, label: 'getLog' });
        const entries = this._parseJsonLines(output, this._schemas.logEntry, 'getLog');

        if (includeNearestVisibleAncestors) {
            const visibleIds = new Set<string>(entries.map((e) => e.change_id));
            await this._resolveNearestVisibleAncestors(entries, visibleIds, await searchSet);
        }

        if (omitChanges && this._cacheEpoch === epoch) {
            for (const entry of entries) {
                this._setCachedLogEntry(entry.commit_id, entry);
            }
        }

        return entries;
    }

    async getLogEntry(revision: string): Promise<JjLogEntry | undefined> {
        const entries = await this.getLog({ revision, limit: 1, omitChanges: true });
        return entries[0];
    }

    private static readonly FALLBACK_LOG_REVSET = 'present(@) | ancestors(immutable_heads().., 2) | trunk()';

    /**
     * The user's configured `revsets.log`, memoized until the next cache clear.
     * Falls back to jj's default when the key is unset or the lookup fails.
     */
    private getConfiguredLogRevset(): Promise<string> {
        if (this._logRevsetPromise) {
            return this._logRevsetPromise;
        }
        const promise = this.run('config', ['get', 'revsets.log'], {
            useCachedSnapshot: true,
            label: 'getLog:revsets.log',
        }).catch(() => JjService.FALLBACK_LOG_REVSET);
        this._logRevsetPromise = promise;
        return promise;
    }

    private async _resolveNearestVisibleAncestors(
        entries: JjLogEntry[],
        visibleIds: Set<string>,
        requestedSearchSet: string | undefined,
    ): Promise<void> {
        const searchSet = requestedSearchSet || JjService.FALLBACK_LOG_REVSET;

        const followUps: Promise<void>[] = [];
        for (const entry of entries) {
            const parentChangeIds = entry.parents.map((p) => p.change_id);
            const hasMissingParents = parentChangeIds.some((p) => !visibleIds.has(p));
            if (!hasMissingParents) {
                entry.nearest_visible_ancestors = parentChangeIds;
                continue;
            }

            // Some parents are not in the current log slice. Find the nearest ones in the search set.
            // We use the same change ID expression for the output to ensure consistency.
            followUps.push(
                (async () => {
                    try {
                        const results = await this.run(
                            'log',
                            [
                                '-r',
                                `heads(::(${entry.change_id}-) & (${searchSet}))`,
                                '--no-graph',
                                '-T',
                                `${CHANGE_ID_EXPR} ++ "\\n"`,
                            ],
                            { useCachedSnapshot: true, label: `nearestAncestors:${entry.change_id}` },
                        );
                        entry.nearest_visible_ancestors = results
                            .split('\n')
                            .map((l) => l.trim())
                            .filter(Boolean);
                    } catch (e) {
                        this.logger.warn(`Warning: failed to fetch nearest ancestors for ${entry.change_id}: ${e}`);
                        entry.nearest_visible_ancestors = [];
                    }
                })(),
            );
        }

        if (followUps.length > 0) {
            await Promise.all(followUps);
        }
    }

    async getLogIds(options: JjLogOptions = {}): Promise<string[]> {
        const { revision, limit } = options;
        const args = ['-T', 'commit_id ++ "\\n"', '--no-graph'];
        if (revision) {
            args.push('-r', revision);
        }
        if (limit) {
            args.push('-n', limit.toString());
        } else if (!revision) {
            args.push('-n', '200');
        }

        const output = await this.run('log', args, { useCachedSnapshot: true, label: 'getLogIds' });
        return output.trim().split('\n').filter(Boolean);
    }

    private async toRepoFilesets(paths: readonly string[], mode: 'exact' | 'prefix' = 'prefix'): Promise<string[]> {
        const repoPaths = await Promise.all(
            paths.map(async (p) => normalizeRepoSeparators(await this.toRepoRelative(p), this._pathPlatform)),
        );
        const formatter = mode === 'exact' ? formatRootFileFileset : formatRootFileset;
        return Array.from(new Set(repoPaths)).map((rel) => formatter(rel));
    }

    async restore(
        paths: string[],
        options: { from?: string; into?: string; changesIn?: string; exact?: boolean } = {},
    ): Promise<void> {
        if (paths.length === 0) {
            return;
        }
        const filesets = await this.toRepoFilesets(paths, options.exact ? 'exact' : 'prefix');
        const cmdArgs: string[] = [];
        if (options.changesIn) {
            cmdArgs.push('--changes-in', options.changesIn);
        } else {
            if (options.from) {
                cmdArgs.push('--from', options.from);
            }
            if (options.into) {
                cmdArgs.push('--into', options.into);
            }
        }
        cmdArgs.push('--', ...filesets);
        await this.run('restore', cmdArgs, { isMutation: true, label: 'restore' });
    }

    /**
     * Split specific file(s) from a revision into a new commit placed before or after it.
     */
    async splitFiles(options: {
        revision: string;
        paths: string[];
        placement: 'before' | 'after';
        message?: string;
    }): Promise<void> {
        if (options.paths.length === 0) {
            return;
        }
        const revision = options.revision.trim();
        if (revision.length === 0) {
            throw new Error('Revision must not be empty.');
        }
        const filesets = await this.toRepoFilesets(options.paths, 'exact');
        const placementFlag = options.placement === 'before' ? '-B' : '-A';
        const args = ['-r', revision, placementFlag, revision, '-m', options.message ?? '', '--', ...filesets];
        await this.run('split', args, { isMutation: true, label: 'split' });
    }

    /**
     * Get the base, left (ours), and right (theirs) content for a conflicted file.
     * Uses `jj resolve` with a custom capture tool to extract the properly separated content.
     */
    async getConflictParts(filePath: string): Promise<{ base: string; left: string; right: string }> {
        const repoRelPath = normalizeRepoSeparators(await this.toRepoRelative(filePath), this._pathPlatform);
        const tempDir = await this.system.fs.mkdtemp(
            pathJoin([this.system.fs.tempDir, 'jj-conflict-'], this.system.platform),
        );

        try {
            // Normalize path separators to forward slashes for safe injection into JS script string
            const tempDirNormalized = pathNormalize(tempDir, this.system.platform);
            const basePath = `${tempDirNormalized}/base`;
            const leftPath = `${tempDirNormalized}/left`;
            const rightPath = `${tempDirNormalized}/right`;

            const normalizedScriptPath = await this.system.process.getHelperScriptPath('conflict-capture');

            let resolveError: unknown;
            try {
                const toolName = 'vscode-capture';
                const toolConfig = this.getToolConfigArgs(toolName, normalizedScriptPath, [
                    '$base',
                    '$left',
                    '$right',
                    tempDirNormalized,
                ]);

                await this.run(
                    'resolve',
                    ['--tool', toolName, ...toolConfig, '--', formatRootFileFileset(repoRelPath)],
                    {
                        useCachedSnapshot: true,
                        label: `getConflictParts ${repoRelPath}`,
                    },
                );
            } catch (err) {
                resolveError = err;
            }

            // Verify that conflict-capture actually ran and wrote the .complete marker
            const marker = pathJoin([tempDir, '.complete'], this.system.platform);
            const isCompleted = await this.system.fs.exists(marker);
            if (!isCompleted) {
                throw (
                    resolveError ??
                    new Error(`Failed to capture conflict parts for ${repoRelPath}: tool did not complete.`)
                );
            }

            const readConflictPart = async (partPath: string): Promise<string> => {
                try {
                    return await this.system.fs.readTextFile(partPath);
                } catch (error: unknown) {
                    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
                        return '';
                    }
                    throw error;
                }
            };

            const base = await readConflictPart(basePath);
            const left = await readConflictPart(leftPath);
            const right = await readConflictPart(rightPath);

            return { base, left, right };
        } finally {
            await this.system.fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    /**
     * Get the left (auto-merged parents) and right (revision) content for a file's diff.
     * Uses the bulk cache, warming it if necessary.
     */
    async getDiffContent(revision: string, filePath: string): Promise<{ left: string; right: string }> {
        const start = performance.now();
        const relativePath = await this.toRepoRelative(filePath);

        // Fast path: in-memory cache hit (0 RPCs, 0 ms)
        const revisionContentCache = this._diffContentCache.get(revision);
        const cached = revisionContentCache?.get(relativePath);
        if (cached) {
            const totalDuration = performance.now() - start;
            const msg = `[Perf:JjService] getDiffContent(${revision}, ${relativePath}) MEMORY-HIT: ${totalDuration.toFixed(1)}ms`;
            this.logger.debug(msg);
            if (typeof console !== 'undefined' && console.log) {
                console.log(msg);
            }
            return cached;
        }

        let warmDuration = 0;
        let readDuration = 0;
        let left = '';
        let right = '';
        let bothMissing = false;

        // The cache may be cleared between obtaining the tempDir and reading from it
        // (an eviction removes the directory). Distinguish that from "file absent from
        // the diff" by checking whether the entry we read from is still the live one.
        const MAX_READ_ATTEMPTS = 2;
        for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt++) {
            const warmStart = performance.now();
            const cache = await this.getDiffForRevision(revision);
            warmDuration += performance.now() - warmStart;

            const leftPath = pathJoin([cache.tempDir, 'left', relativePath], this._pathPlatform);
            const rightPath = pathJoin([cache.tempDir, 'right', relativePath], this._pathPlatform);

            // Read left and right in one host call; null means the side is absent from the diff.
            const readStart = performance.now();
            const [leftContent, rightContent] = await this.system.fs.readTextFiles([leftPath, rightPath]);
            readDuration += performance.now() - readStart;

            left = leftContent ?? '';
            right = rightContent ?? '';
            bothMissing = leftContent === null && rightContent === null;

            const evictedDuringRead = this._diffCache.peek(revision)?.tempDir !== cache.tempDir;
            if (!bothMissing || !evictedDuringRead || attempt === MAX_READ_ATTEMPTS) {
                break;
            }
            this.logger.debug(`getDiffContent ${revision} ${relativePath}: diff cache evicted during read, retrying`);
        }

        if (bothMissing) {
            // If neither file exists in the bulk diff cache, it means there are no differences
            // for this file relative to the parent(s). Fallback to fetching file content directly.
            // This handles "Quick Diff" on unchanged files where we need the base content.
            try {
                this.logger.debug(`getDiffContent fallback ${filePath} ${revision}`);
                const content = await this.getFileContent(filePath, revision);
                left = content;
                right = content;
            } catch {
                // If file doesn't exist in revision, return empty
                left = '';
                right = '';
            }
        }

        const result = { left, right };

        let contentMap = this._diffContentCache.get(revision);
        if (!contentMap) {
            contentMap = new Map();
            this._diffContentCache.set(revision, contentMap);
        }
        contentMap.set(relativePath, result);

        const totalDuration = performance.now() - start;
        const msg = `[Perf:JjService] getDiffContent(${revision}, ${relativePath}) took ${totalDuration.toFixed(1)}ms (warm: ${warmDuration.toFixed(1)}ms, read: ${readDuration.toFixed(1)}ms)`;
        this.logger.debug(msg);
        if (typeof console !== 'undefined' && console.log) {
            console.log(msg);
        }
        return result;
    }

    private async readOptionalBinaryFile(filePath: string): Promise<Uint8Array | null> {
        try {
            return await this.system.fs.readBinaryFile(filePath);
        } catch (error: unknown) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    /**
     * Get the left (auto-merged parents) and right (revision) binary bytes for a file's diff.
     * Uses the bulk cache, warming it if necessary.
     */
    async getDiffBinaryContent(revision: string, filePath: string): Promise<{ left: Uint8Array; right: Uint8Array }> {
        const start = performance.now();
        const relativePath = await this.toRepoRelative(filePath);

        const revisionBinaryCache = this._diffBinaryCache.get(revision);
        const cached = revisionBinaryCache?.get(relativePath);
        if (cached) {
            const totalDuration = performance.now() - start;
            const msg = `[Perf:JjService] getDiffBinaryContent(${revision}, ${relativePath}) MEMORY-HIT: ${totalDuration.toFixed(1)}ms`;
            this.logger.debug(msg);
            if (typeof console !== 'undefined' && console.log) {
                console.log(msg);
            }
            return cached;
        }

        let warmDuration = 0;
        let readDuration = 0;
        let left: Uint8Array = new Uint8Array(0);
        let right: Uint8Array = new Uint8Array(0);
        let bothMissing = false;

        const MAX_READ_ATTEMPTS = 2;
        for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt++) {
            const warmStart = performance.now();
            const cache = await this.getDiffForRevision(revision);
            warmDuration += performance.now() - warmStart;

            const leftPath = pathJoin([cache.tempDir, 'left', relativePath], this._pathPlatform);
            const rightPath = pathJoin([cache.tempDir, 'right', relativePath], this._pathPlatform);

            const readStart = performance.now();
            const [leftBytes, rightBytes] = await Promise.all([
                this.readOptionalBinaryFile(leftPath),
                this.readOptionalBinaryFile(rightPath),
            ]);
            readDuration += performance.now() - readStart;

            left = leftBytes ?? new Uint8Array(0);
            right = rightBytes ?? new Uint8Array(0);
            bothMissing = leftBytes === null && rightBytes === null;

            const evictedDuringRead = this._diffCache.peek(revision)?.tempDir !== cache.tempDir;
            if (!bothMissing || !evictedDuringRead || attempt === MAX_READ_ATTEMPTS) {
                break;
            }
            this.logger.debug(
                `getDiffBinaryContent ${revision} ${relativePath}: diff cache evicted during read, retrying`,
            );
        }

        if (bothMissing) {
            try {
                this.logger.debug(`getDiffBinaryContent fallback ${filePath} ${revision}`);
                const bytes = await this.getFileBinaryContent(filePath, revision);
                left = bytes;
                right = bytes;
            } catch {
                left = new Uint8Array(0);
                right = new Uint8Array(0);
            }
        }

        const result = { left, right };

        let binaryMap = this._diffBinaryCache.get(revision);
        if (!binaryMap) {
            binaryMap = new Map();
            this._diffBinaryCache.set(revision, binaryMap);
        }
        binaryMap.set(relativePath, result);

        const totalDuration = performance.now() - start;
        const msg = `[Perf:JjService] getDiffBinaryContent(${revision}, ${relativePath}) took ${totalDuration.toFixed(1)}ms (warm: ${warmDuration.toFixed(1)}ms, read: ${readDuration.toFixed(1)}ms)`;
        this.logger.debug(msg);
        if (typeof console !== 'undefined' && console.log) {
            console.log(msg);
        }
        return result;
    }

    /**
     * Ensures that the diff cache for a revision is warm and valid.
     * Extracts all changed files into a temporary directory using a single 'jj diffedit' call.
     */
    async getDiffForRevision(revision: string, force: boolean = false): Promise<{ tempDir: string; expires: number }> {
        const start = performance.now();
        if (force) {
            this._diffContentCache.delete(revision);
            this._diffBinaryCache.delete(revision);
            await this._diffCache.delete(revision);
        }
        const isWarm = this._diffCache.has(revision);
        const result = await this._diffCache.getOrFetch(revision, () => this._warmDiffCache(revision));
        const duration = performance.now() - start;
        const msg = `[Perf:JjService] getDiffForRevision(${revision}) ${isWarm ? 'HIT' : 'WARM'}: ${duration.toFixed(1)}ms`;
        this.logger.debug(msg);
        if (typeof console !== 'undefined' && console.log) {
            console.log(msg);
        }
        return result;
    }

    private async _warmDiffCache(revision: string): Promise<{ tempDir: string; expires: number }> {
        const toolName = 'vscode-bulk-capture';
        const toolConfig = this.getToolConfigArgs(toolName, HELPER_SCRIPT_TOKEN, [
            '$left',
            '$right',
            `${SCRATCH_DIR_TOKEN}/left`,
            `${SCRATCH_DIR_TOKEN}/right`,
        ]);

        // One host round trip: mkdtemp + mkdir left/right + resolve batch-diff + jj diffedit + marker check.
        // batch-diff exits 1 by design (to abort the diffedit); the `.complete` marker signals success.
        const result = await this.runInScratchDir(
            'diffedit',
            ['-r', revision, '--ignore-immutable', '--tool', toolName, ...toolConfig],
            {
                scratchPrefix: 'jj-bulk-diff-',
                subdirs: ['left', 'right'],
                helperScript: 'batch-diff',
                completionMarker: 'right/.complete',
            },
            {
                useCachedSnapshot: true,
                label: `getDiffForRevision ${revision}`,
            },
        );

        return {
            tempDir: result.scratchDir,
            expires: Date.now() + 5 * 60_000,
        };
    }

    async clearCache(): Promise<void> {
        this._cacheEpoch++;
        this._logEntryCache.clear();
        this._logRevsetPromise = undefined;
        this._gitRoot = undefined;
        this._gitRootPromise = undefined;
        this._gitBlobHashCache.clear();
        this._diffContentCache.clear();
        this._diffBinaryCache.clear();
        this._gitBlobContentCache.clear();
        this._gitCommitDetailsCache.clear();
        this._gitRangeFilesCache.clear();
        await Promise.all([this._diffCache.clear(), this._changesCache.clear()]);
    }

    /**
     * Check if a revision is immutable.
     */
    async isImmutable(revision: string): Promise<boolean> {
        const stdout = await this.run('log', ['-r', revision, '-T', 'immutable', '--no-graph'], {
            useCachedSnapshot: true,
            label: 'isImmutable',
        });
        return stdout.trim() === 'true';
    }

    private async runMutation<T>(op: () => Promise<T>): Promise<T> {
        this._writeOperationCount++;
        try {
            const result = this._mutationMutex.then(() => op());
            this._mutationMutex = result.then(
                () => {},
                () => {},
            );
            return await result;
        } finally {
            this._writeOperationCount--;
            this._lastWriteTime = Date.now();
        }
    }

    /**
     * Atomic write operation for multiple files in a revision.
     * Serialized via a mutation queue to prevent divergent commits.
     */
    async setFilesContent(revision: string, files: Map<string, string>): Promise<void> {
        if (files.size === 0) {
            return;
        }

        return this.runMutation(async () => {
            const hostPlatform = this.system.platform;
            const tempDir = await this.system.fs.mkdtemp(
                pathJoin([this.system.fs.tempDir, 'jj-batch-edit-'], hostPlatform),
            );
            try {
                const writePromises = Array.from(files.entries()).map(async ([filePath, content], idx) => {
                    const repoRelPath = normalizeRepoSeparators(
                        await this.toRepoRelative(filePath),
                        this._pathPlatform,
                    );
                    const safeName = repoRelPath.replace(/[\\/]/g, '_');
                    const tmpPath = pathJoin([tempDir, `src_${idx}_${safeName}`], hostPlatform);
                    await this.system.fs.writeTextFile(tmpPath, content);
                    return { repoRelPath, tmpPath };
                });

                const fileList = await Promise.all(writePromises);

                const normalizedScriptPath = await this.system.process.getHelperScriptPath('batch-edit');
                const toolName = 'vscode-batch-write';

                const argsTemplate = ['$left', '$right'];
                for (const f of fileList) {
                    argsTemplate.push(pathNormalize(f.tmpPath, hostPlatform));
                    argsTemplate.push(f.repoRelPath);
                }
                const toolConfig = this.getToolConfigArgs(toolName, normalizedScriptPath, argsTemplate);

                await this.runInternal(
                    'diffedit',
                    [
                        '-r',
                        revision,
                        '--tool',
                        toolName,
                        ...toolConfig,
                        '--',
                        ...fileList.map((f) => formatRootFileFileset(f.repoRelPath)),
                    ],
                    { isMutation: true, label: 'setFilesContent' },
                );
            } finally {
                await this.system.fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
            }
        });
    }

    /**
     * Set the content of a file in a specific revision.
     */
    async setFileContent(revision: string, filePath: string, content: string): Promise<void> {
        return this.setFilesContent(revision, new Map([[filePath, content]]));
    }

    /**
     * Squash changes from one revision to its parent or another revision.
     * If no revision is specified, it defaults to the working copy (@).
     * If no intoRevision is specified, it defaults to the parent (@-).
     *
     * @param options.paths Files to squash. If empty, squashes all changes in the revision.
     * @param options.revision The revision to squash from.
     * @param options.intoRevision The revision to squash into.
     * @param options.ontoRevision Target revision to squash onto (creating a new commit on top of destination).
     * @param options.message New description for the destination revision.
     * @param options.useDestinationMessage If true, keeps the destination revision's description.
     */
    async squashRevision(
        options: {
            paths?: string[];
            revision?: string;
            intoRevision?: string;
            ontoRevision?: string;
            message?: string;
            useDestinationMessage?: boolean;
        } = {},
    ): Promise<void> {
        const { paths = [], revision, intoRevision, ontoRevision, message, useDestinationMessage } = options;
        if (intoRevision && ontoRevision) {
            throw new Error('Cannot specify both intoRevision and ontoRevision.');
        }
        if (revision && (revision === intoRevision || revision === ontoRevision)) {
            throw new Error('Cannot squash revision into or onto itself.');
        }
        const args: string[] = [];
        const filesets = paths.length > 0 ? await this.toRepoFilesets(paths, 'prefix') : [];

        if (ontoRevision) {
            // Squash onto target (creating a new commit on top of ontoRevision)
            if (revision) {
                args.push('--from', revision);
            }
            args.push('--onto', ontoRevision);
        } else if (intoRevision) {
            // Squash from one revision into another
            if (revision) {
                args.push('--from', revision);
            }
            args.push('--into', intoRevision);
        } else if (revision) {
            // Squash this revision into its parent
            args.push('-r', revision);
        }
        if (useDestinationMessage) {
            args.push('-u');
        }
        if (message) {
            args.push('-m', message);
        }
        if (filesets.length > 0) {
            args.push('--', ...filesets);
        }
        await this.run('squash', args, { isMutation: true, label: 'squashRevision' });
    }

    async rebase(source: string, options: RebaseOptions): Promise<string> {
        const cleanSource = source.trim();
        if (cleanSource.length === 0) {
            throw new Error('Rebase source must not be empty');
        }

        const rawTargets = Array.isArray(options.target) ? options.target : [options.target];
        const targets = Array.from(new Set(rawTargets.map((t) => t.trim()).filter((t) => t.length > 0)));
        if (targets.length === 0) {
            throw new Error('Rebase target must not be empty');
        }
        if (targets.includes(cleanSource)) {
            throw new Error('Cannot rebase a revision onto or around itself');
        }

        const args: string[] = [];
        const placement = options.placement ?? 'onto';
        const flag = placement === 'after' ? '-A' : placement === 'before' ? '-B' : '-o';
        targets.forEach((t) => {
            args.push(flag, t);
        });

        if (options.mode === 'revision') {
            // Rebase revision (cherry-pick like behavior)
            args.push('-r', cleanSource);
        } else {
            // Rebase set (source and descendants)
            args.push('-s', cleanSource);
        }
        return this.run('rebase', args, { isMutation: true, label: 'rebase' });
    }

    async duplicate(revision: string, options: { onto?: string } = {}): Promise<string> {
        const args: string[] = [];
        if (options.onto) {
            args.push('-o', options.onto);
        }
        args.push(revision);
        return this.run('duplicate', args, { isMutation: true, label: 'duplicate' });
    }

    async abandon(revisions: string | string[]): Promise<string> {
        const revs = Array.isArray(revisions) ? revisions : [revisions];
        return this.run('abandon', revs, { isMutation: true, label: 'abandon' });
    }

    async simplifyParents(revisions: string[]): Promise<string> {
        const revs = Array.from(new Set(revisions.map((r) => r.trim()).filter((r) => r.length > 0)));
        if (revs.length === 0) {
            throw new Error('At least one revision is required for simplify-parents');
        }
        const args = revs.flatMap((rev) => ['-r', rev]);
        return this.run('simplify-parents', args, { isMutation: true, label: 'simplifyParents' });
    }

    async undo(): Promise<string> {
        return this.run('undo', [], { isMutation: true, label: 'undo' });
    }

    async redo(): Promise<string> {
        return this.run('redo', [], { isMutation: true, label: 'redo' });
    }

    async prev(): Promise<string> {
        return this.run('prev', [], { isMutation: true, label: 'prev' });
    }

    async next(): Promise<string> {
        return this.run('next', [], { isMutation: true, label: 'next' });
    }

    async getGitRemotes(): Promise<{ name: string; url: string }[]> {
        try {
            const output = await this.run('git', ['remote', 'list'], {
                useCachedSnapshot: true,
                label: 'getGitRemotes',
            });
            return output
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .map((line) => {
                    const parts = line.split(/\s+/);
                    return { name: parts[0], url: parts[1] || '' };
                });
        } catch {
            return [];
        }
    }

    /**
     * Returns the forge web base URL resolved by jujutsu's `git_web_url([remote])` template.
     * When `remote` is omitted, prefers `'origin'` and falls back to the first configured remote.
     */
    async getGitWebUrl(remote?: string): Promise<string | undefined> {
        let targetRemote = remote?.trim();
        if (!targetRemote) {
            const remotes = await this.getGitRemotes();
            if (remotes.length === 0) {
                return undefined;
            }
            targetRemote = remotes.find((r) => r.name === 'origin')?.name ?? remotes[0]?.name;
        }

        const escapedRemote = targetRemote ? targetRemote.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : undefined;
        const template = escapedRemote ? `git_web_url("${escapedRemote}")` : 'git_web_url()';

        try {
            const output = await this.run('log', ['--no-graph', '-r', 'root()', '-T', template], {
                useCachedSnapshot: true,
                label: 'getGitWebUrl',
            });
            const trimmed = output.trim();
            return trimmed.length > 0 ? trimmed : undefined;
        } catch {
            return undefined;
        }
    }

    async getChildren(revision: string = '@'): Promise<string[]> {
        const output = await this.run(
            'log',
            ['-r', `children(${revision})`, '--no-graph', '-T', 'change_id ++ "\\n"'],
            { useCachedSnapshot: true, label: 'getChildren' },
        );
        return output
            .trim()
            .split('\n')
            .filter((line) => line.length > 0);
    }

    /**
     * Checks which of the provided paths are tracked by jj.
     * @param paths An array of workspace-relative paths to check.
     * @returns A subset of the input `paths` that are tracked. Note that for
     * directories, it returns the tracked files contained within them.
     */
    async checkTrackedPaths(paths: string[]): Promise<string[]> {
        const nonEmptyPaths = paths.filter((p) => p.length > 0);
        if (nonEmptyPaths.length === 0) {
            return [];
        }

        // Format as root:"..." filesets so literal backslashes and metacharacters match tracked files cleanly.
        const filesets = await this.toRepoFilesets(nonEmptyPaths, 'prefix');
        const args = ['list', '-T', 'path.display() ++ "\\n"', '--', ...filesets];
        try {
            const output = await this.run('file', args, { useCachedSnapshot: true, label: 'checkTrackedPaths' });
            return output
                .split('\n')
                .map((line) => normalizeRepoSeparators(line.trim(), this._pathPlatform))
                .filter((line) => line.length > 0);
        } catch {
            return nonEmptyPaths;
        }
    }

    /**
     * Returns whether `repoRelativePath` exists in the tree at `revision`.
     */
    async hasFileAtRevision(repoRelativePath: string, revision: string): Promise<boolean> {
        const trimmedPath = normalizeRepoSeparators(repoRelativePath.trim(), this._pathPlatform);
        const trimmedRev = revision.trim();
        if (!trimmedPath || !trimmedRev) {
            return false;
        }
        try {
            const output = await this.run(
                'file',
                ['list', '-r', trimmedRev, '-T', 'path.display() ++ "\\n"', '--', formatRootFileFileset(trimmedPath)],
                { useCachedSnapshot: true, label: 'hasFileAtRevision' },
            );
            return output.trim().length > 0;
        } catch {
            return true;
        }
    }

    async new(
        options: { message?: string; parents?: string[]; insertBefore?: string[]; insertAfter?: string[] } = {},
    ): Promise<string> {
        const { message, parents = [], insertBefore = [], insertAfter = [] } = options;
        const args: string[] = [];
        if (message) {
            args.push('-m', message);
        }
        for (const rev of insertBefore) {
            args.push('--insert-before', rev);
        }
        for (const rev of insertAfter) {
            args.push('--insert-after', rev);
        }

        if ((insertBefore.length > 0 || insertAfter.length > 0) && parents.length > 0) {
            throw new Error('Cannot specify parents along with insertBefore or insertAfter.');
        }

        // Standard usage: parents are positional arguments
        args.push(...parents);

        await this.run('new', args, { isMutation: true, label: 'new' });
        const output = await this.run('log', ['-r', '@', '--no-graph', '-T', 'change_id'], {
            useCachedSnapshot: true,
            label: 'new:getChangeId',
        });
        return output.trim();
    }

    async workspaceAdd(destination: string, name?: string): Promise<string> {
        const args = [destination];
        if (name) {
            args.push('--name', name);
        }
        return this.run('workspace', ['add', ...args], { isMutation: true, label: 'workspaceAdd' });
    }

    async workspaceForget(workspaceName: string): Promise<void> {
        await this.run('workspace', ['forget', workspaceName], { isMutation: true, label: 'workspaceForget' });
    }

    async getWorkspaces(): Promise<JjWorkspace[]> {
        const template = buildLogTemplate(WORKSPACE_SCHEMA);
        const output = await this.run('workspace', ['list', '-T', template], {
            useCachedSnapshot: true,
            label: 'getWorkspaces',
        });
        return this._parseJsonLines(output, JjWorkspaceSchema, 'getWorkspaces');
    }

    async getWorkspaceRoot(workspaceName?: string): Promise<string> {
        const args = [];
        if (workspaceName) {
            args.push('--name', workspaceName);
        }
        const output = await this.run('workspace', ['root', ...args], {
            useCachedSnapshot: true,
            label: 'getWorkspaceRoot',
        });
        return output.trim();
    }

    async getFileContent(
        filePath: string,
        revision: string = '@',
        conflictStyle: 'git' | 'default' = 'default',
    ): Promise<string> {
        const platform = this._pathPlatform;
        const repoRelPath = normalizeRepoSeparators(await this.toRepoRelative(filePath), platform);

        // Check cache first (only for default conflict style for now)
        if (conflictStyle === 'default') {
            try {
                const cache = await this.getDiffForRevision(revision);
                const rightPath = pathJoin([cache.tempDir, 'right', repoRelPath], platform);
                return await this.system.fs.readTextFile(rightPath);
            } catch {
                // Fall through if not in cache (e.g. file not changed in this revision)
            }
        }

        const args = ['show', '-r', revision];
        if (conflictStyle === 'git') {
            args.push('--config=ui.conflict-marker-style=git');
        }
        args.push('--', formatRootFileFileset(repoRelPath));
        return this.run('file', args, { trim: false, useCachedSnapshot: true, label: 'getFileContent' });
    }

    async getFileBinaryContent(filePath: string, revision: string = '@'): Promise<Uint8Array> {
        const platform = this._pathPlatform;
        const relativePath = normalizeRepoSeparators(await this.toRepoRelative(filePath), platform);
        try {
            const cache = await this.getDiffForRevision(revision);
            const rightPath = pathJoin([cache.tempDir, 'right', relativePath], platform);
            return await this.system.fs.readBinaryFile(rightPath);
        } catch {
            // Fall through if not in cache (e.g. file not changed in this revision)
        }

        const workspaceRelPath = await this.toRelative(filePath);
        if (revision === '@') {
            try {
                const fullPath = pathResolve([this.workspaceRoot, workspaceRelPath], platform);
                return await this.system.fs.readBinaryFile(fullPath);
            } catch {
                // Fall through if disk file is missing/unreadable
            }
        }

        const toolName = 'vscode-bulk-capture';
        const toolConfig = this.getToolConfigArgs(toolName, HELPER_SCRIPT_TOKEN, [
            '$left',
            '$right',
            `${SCRATCH_DIR_TOKEN}/left`,
            `${SCRATCH_DIR_TOKEN}/right`,
        ]);

        const result = await this.runInScratchDir(
            'diffedit',
            [
                '--from',
                'root()',
                '--to',
                revision,
                '--ignore-immutable',
                '--tool',
                toolName,
                ...toolConfig,
                '--',
                formatRootFileFileset(relativePath),
            ],
            {
                scratchPrefix: 'jj-file-bin-',
                subdirs: ['left', 'right'],
                helperScript: 'batch-diff',
                completionMarker: 'right/.complete',
            },
            {
                useCachedSnapshot: true,
                label: `getFileBinaryContent ${revision} ${relativePath}`,
            },
        );

        try {
            const rightPath = pathJoin([result.scratchDir, 'right', relativePath], platform);
            return await this.system.fs.readBinaryFile(rightPath);
        } finally {
            await this.system.fs.rm(result.scratchDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    async resolve(revision: string): Promise<void> {
        await this.run('new', [revision], { isMutation: true, label: 'resolve' });
    }

    async getConflictedFiles(): Promise<string[]> {
        try {
            const output = await this.run('resolve', ['--list'], {
                useCachedSnapshot: true,
                label: 'getConflictedFiles',
            });
            return output
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .map((line) => normalizeRepoSeparators(line.split(/\s+/)[0], this._pathPlatform));
        } catch {
            // No conflicts at this revision
            return [];
        }
    }

    async describe(message: string, revision?: string): Promise<void> {
        const cmdArgs = ['-m', message];
        if (revision) {
            cmdArgs.push(revision);
        }
        await this.run('describe', cmdArgs, { isMutation: true, label: 'describe' });
    }

    async commit(message: string): Promise<void> {
        await this.run('commit', ['-m', message], { isMutation: true, label: 'commit' });
    }

    async getDescription(revision: string): Promise<string> {
        return this.run('log', ['-r', revision, '--no-graph', '-T', 'description'], {
            useCachedSnapshot: true,
            label: 'getDescription',
        });
    }

    async cat(filePath: string, revision: string = '@-'): Promise<string> {
        const repoRelPath = normalizeRepoSeparators(await this.toRepoRelative(filePath), this._pathPlatform);
        return this.run('file', ['show', '-r', revision, '--', formatRootFileFileset(repoRelPath)], {
            trim: false,
            useCachedSnapshot: true,
            label: 'cat',
        });
    }

    async status(): Promise<string> {
        return this.run('status', [], { isMutation: true, useCachedSnapshot: false, label: 'status' });
    }

    /**
     * Snapshots the working copy (records any on-disk edits into `@`) without
     * clearing caches. If the snapshot produced a new operation, the caller can
     * detect it via {@link getOperationHeads} and invalidate selectively.
     */
    async snapshotWorkingCopy(): Promise<void> {
        await this.run('status', [], { useCachedSnapshot: false, label: 'snapshot' });
    }

    /**
     * Returns the current operation head IDs, sorted. Reads the op heads store
     * directly (a single directory listing) rather than spawning `jj`, so it is
     * cheap enough to call on every refresh to detect whether anything changed.
     */
    async getOperationHeads(): Promise<string[]> {
        const storePath = await this.getRepoStorePath();
        const platform = this._pathPlatform;
        try {
            const heads = await this.system.fs.readdir(pathJoin([storePath, 'op_heads', 'heads'], platform));
            return heads.sort();
        } catch {
            const checkoutBytes = await this.system.fs.readBinaryFile(
                pathJoin([this.workspaceRoot, '.jj', 'working_copy', 'checkout'], platform),
            );
            const hex = Array.from(checkoutBytes, (b) => b.toString(16).padStart(2, '0')).join('');
            return [hex];
        }
    }

    async getChanges(revision: string): Promise<JjFileChangeWithStats[]> {
        return this._changesCache.getOrFetch(revision, () => this._doGetChanges(revision));
    }

    /**
     * Retrieves the file changes between two revisions (`fromRevision` and `toRevision`).
     */
    async getChangesBetween(fromRevision: string, toRevision: string): Promise<JjFileChange[]> {
        const cacheKey = `${fromRevision}..${toRevision}`;
        return this._changesCache.getOrFetch(cacheKey, () => this._doGetChangesBetween(fromRevision, toRevision));
    }

    private async _doGetChanges(revision: string): Promise<JjFileChangeWithStats[]> {
        const combinedTemplate = buildLogTemplate({
            changes: {
                type: 'array',
                expr: 'self.diff().files()',
                itemSchema: buildDiffFileSchema('item'),
            },
            stats: {
                type: 'array',
                expr: 'self.diff().stat().files()',
                itemSchema: {
                    path: { type: 'json', expr: 'item.path().display()' },
                    additions: { type: 'raw', expr: 'item.lines_added()' },
                    deletions: { type: 'raw', expr: 'item.lines_removed()' },
                },
            },
            conflicts: {
                type: 'array',
                expr: 'self.conflicted_files()',
                itemSchema: {
                    path: { type: 'json', expr: 'item.path().display()' },
                    conflictSides: { type: 'raw', expr: 'item.conflict_side_count()' },
                },
            },
        });

        const output = await this.run('log', ['-r', revision, '--no-graph', '-T', combinedTemplate], {
            useCachedSnapshot: true,
            label: 'getChanges',
        });
        const entries = this._parseJsonLines(output, this._schemas.changesAndStatsOutput, 'getChanges');
        if (entries.length === 0) {
            return [];
        }

        if (entries.length > 1) {
            this.logger.warn(
                `Expected single commit for revision '${revision}' in getChanges, but got ${entries.length} entries.`,
            );
        }

        const { changes, stats, conflicts } = entries[0];
        const statsMap = new Map<string, DiffStatEntry>(stats.map((s) => [s.path, s]));
        const conflictMap = new Map<string, ConflictedFileEntry>(conflicts.map((c) => [c.path, c]));

        const results: JjFileChangeWithStats[] = changes.map((c) => {
            const stat = statsMap.get(c.path);
            const conflict = conflictMap.get(c.path);
            if (conflict) {
                conflictMap.delete(c.path);
            }
            return {
                ...c,
                conflicted: c.conflicted || conflict !== undefined,
                conflictSides: c.conflictSides ?? conflict?.conflictSides,
                additions: stat?.additions ?? 0,
                deletions: stat?.deletions ?? 0,
            };
        });

        for (const [path, conflict] of conflictMap) {
            results.push({
                path,
                status: 'modified',
                conflicted: true,
                conflictSides: conflict.conflictSides,
                additions: 0,
                deletions: 0,
            });
        }

        return results;
    }

    private async _doGetChangesBetween(fromRevision: string, toRevision: string): Promise<JjFileChange[]> {
        const diffTemplate = buildLogTemplate(buildDiffFileSchema('self'));

        const output = await this.run('diff', ['-T', diffTemplate, '--from', fromRevision, '--to', toRevision], {
            useCachedSnapshot: true,
            label: 'getChangesBetween',
        });

        return this._parseJsonLines(output, this._schemas.fileChange, 'getChangesBetween');
    }

    private _parseJsonLines<T>(output: string, schema: z.ZodType<T>, label: string): T[] {
        const items: T[] = [];
        let parseErrorCount = 0;

        for (const line of output.trim().split('\n')) {
            if (!line) {
                continue;
            }
            const jsonStart = line.indexOf('{');
            if (jsonStart === -1) {
                continue;
            }
            try {
                const parsed = JSON.parse(line.substring(jsonStart));
                const validation = schema.safeParse(parsed);
                if (validation.success) {
                    items.push(validation.data);
                } else {
                    parseErrorCount++;
                    this.logger.debug(`Failed to validate ${label} entry: ${validation.error.message} (line: ${line})`);
                }
            } catch (e) {
                parseErrorCount++;
                this.logger.debug(`Failed to parse ${label} entry (line: ${line}): ${e}`);
            }
        }

        if (parseErrorCount > 0) {
            this.logger.warn(`Encountered ${parseErrorCount} invalid JSON entries while parsing ${label} output.`);
        }

        return items;
    }

    async getWorkingCopyChanges(): Promise<JjStatusEntry[]> {
        return this.getChanges('@');
    }

    async edit(revision: string): Promise<string> {
        return this.run('edit', [revision], { isMutation: true, label: 'edit' });
    }

    async showDetails(revision: string): Promise<string> {
        return this.run('show', ['-r', revision, '--stat', '--color', 'always'], { useCachedSnapshot: true });
    }

    async getDiff(revision: string, file: string): Promise<string> {
        const repoRelPath = normalizeRepoSeparators(await this.toRepoRelative(file), this._pathPlatform);
        return this.run('diff', ['--git', '-r', revision, '--', formatRootFileFileset(repoRelPath)], {
            useCachedSnapshot: true,
        });
    }

    async upload(revision: string | undefined, command: string, ...args: string[]): Promise<string> {
        const finalArgs = [...args];
        if (revision) {
            finalArgs.push('-r', revision);
        }
        return this.run(command, finalArgs, {
            isMutation: true,
            label: 'upload',
            timeout: UPLOAD_TIMEOUT_MS,
        });
    }

    async runExternalMutation(
        executable: string,
        args: string[],
        options: { timeout?: number; cwd?: string; label?: string } = {},
    ): Promise<string> {
        return this.runMutation(async () => {
            const result = await this.execTracked(
                executable,
                args,
                { ...options, isMutation: true, timeout: options.timeout ?? UPLOAD_TIMEOUT_MS },
                (_allArgs, execOptions) => this.system.process.execFile(executable, args, execOptions),
            );
            return result.stdout.trim();
        });
    }

    async sync(command: string = 'git', ...args: string[]): Promise<string> {
        const finalArgs = command === 'git' && args.length === 0 ? ['fetch'] : args;
        return this.run(command, finalArgs, {
            isMutation: true,
            label: 'sync',
            timeout: UPLOAD_TIMEOUT_MS,
        });
    }

    /**
     * Squash specific line ranges (selection) from a file to its parent revision.
     *
     * @param filePath Path to the file (absolute or relative to the workspace root).
     * @param ranges 0-indexed line ranges in the 'revision' to move.
     * @param revision The revision to move changes from (default: @).
     */
    async squashSelectionIntoParent(filePath: string, ranges: SelectionRange[], revision: string = '@'): Promise<void> {
        const parentRev = `${revision}-`;
        const { left: baseContent } = await this.getDiffContent(revision, filePath);
        const diffOutput = await this.getDiff(revision, filePath);

        const wantedContent = PatchHelper.applySelectedLines(baseContent, diffOutput, ranges);

        await this.runPartialSquash(revision, parentRev, filePath, wantedContent);
    }

    private async runPartialSquash(
        fromRev: string,
        intoRev: string,
        filePath: string,
        wantedContent: string,
    ): Promise<void> {
        const hostPlatform = this.system.platform;
        const repoRelPath = normalizeRepoSeparators(await this.toRepoRelative(filePath), this._pathPlatform);
        const tmpDir = await this.system.fs.mkdtemp(
            pathJoin([this.system.fs.tempDir, 'jj-partial-squash-'], hostPlatform),
        );
        const tmpFile = pathJoin([tmpDir, 'wanted_content'], hostPlatform);

        try {
            await this.system.fs.writeTextFile(tmpFile, wantedContent);
            const toolName = 'partial-squash';
            const normalizedScriptPath = await this.system.process.getHelperScriptPath('batch-edit');
            const toolConfig = this.getToolConfigArgs(toolName, normalizedScriptPath, [
                '$left',
                '$right',
                pathNormalize(tmpFile, hostPlatform),
                repoRelPath,
            ]);

            // squash --from X --into Y --tool ...
            const args = [
                '--from',
                fromRev,
                '--into',
                intoRev,
                '--tool',
                toolName,
                ...toolConfig,
                '--',
                formatRootFileFileset(repoRelPath),
            ];

            await this.run('squash', args, { isMutation: true });
        } finally {
            await this.system.fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    async absorb(options: { paths?: string[]; fromRevision?: string } = {}): Promise<string> {
        const { paths, fromRevision } = options;
        const args: string[] = [];

        if (fromRevision) {
            args.push('--from', fromRevision);
        }
        if (paths && paths.length > 0) {
            const filesets = await this.toRepoFilesets(paths, 'prefix');
            args.push('--', ...filesets);
        }

        return this.run('absorb', args, { isMutation: true, label: 'absorb' });
    }

    private _gitBlobHashCache = new Map<string, Map<string, string | null>>();

    async getGitBlobHashes(commitId: string, filePaths: string[]): Promise<Map<string, string>> {
        if (filePaths.length === 0) {
            return new Map();
        }

        let commitCache = this._gitBlobHashCache.get(commitId);
        if (!commitCache) {
            commitCache = new Map<string, string | null>();
            this._gitBlobHashCache.set(commitId, commitCache);
        }

        const missingPaths: string[] = [];
        const resultMap = new Map<string, string>();

        for (const filePath of filePaths) {
            const cachedSha = commitCache.get(filePath);
            if (cachedSha !== undefined) {
                if (cachedSha !== null) {
                    resultMap.set(filePath, cachedSha);
                }
            } else {
                missingPaths.push(filePath);
            }
        }

        if (missingPaths.length === 0) {
            return resultMap;
        }

        // We use raw git command because jj doesn't expose ls-tree
        try {
            const gitRoot = await this.getGitRoot();
            const timeout = 10000; // 10s safety timeout
            const res = await this.system.process.execFile(
                'git',
                [
                    '--no-pager',
                    '--no-optional-locks',
                    ...(gitRoot ? [`--git-dir=${gitRoot}`] : []),
                    'ls-tree',
                    '--full-tree',
                    commitId,
                    '--',
                    ...missingPaths,
                ],
                {
                    cwd: this.workspaceRoot,
                    maxBuffer: 10 * 1024 * 1024,
                    timeout,
                },
            );

            // Output format: <mode> blob <sha> <tab><path>
            // 100644 blob 3a8500ab7725f03cca3806ee9ebaf7b4b53c3ca6    vitest.config.js

            const lines = res.stdout.trim().split('\n');
            const foundPaths = new Set<string>();
            for (const line of lines) {
                if (!line) {
                    continue;
                }

                // Split by whitespace, but handle path potentially containing spaces (though git ls-tree usually quotes)
                // Git ls-tree output is fairly standard: mode type sha\tpath
                const parts = line.split(/\s+/);
                if (parts.length >= 4 && parts[1] === 'blob') {
                    const sha = parts[2];
                    const pathPart = line.substring(line.indexOf('\t') + 1);
                    const cleanPath = unquoteGitPath(pathPart);

                    commitCache.set(cleanPath, sha);
                    resultMap.set(cleanPath, sha);
                    foundPaths.add(cleanPath);
                }
            }

            // Negative cache requested paths absent from ls-tree
            for (const path of missingPaths) {
                if (!foundPaths.has(path)) {
                    commitCache.set(path, null);
                }
            }
        } catch (err) {
            // If git fails (e.g. not a git repo, or commit not found in git backing), return partial resultMap
            // This is expected fallback behavior
            this.logger.warn(`getGitBlobHashes failed: ${getErrorMessage(err)}`);
        }

        return resultMap;
    }

    private _diffHunksCache = new Map<string, DiffHunkRange[] | null>();
    private static readonly MAX_DIFF_HUNKS_CACHE_KEYS = 500;

    private _setDiffHunksCache(key: string, value: DiffHunkRange[] | null): void {
        if (this._diffHunksCache.size >= JjService.MAX_DIFF_HUNKS_CACHE_KEYS) {
            const firstKey = this._diffHunksCache.keys().next().value;
            if (firstKey !== undefined) {
                this._diffHunksCache.delete(firstKey);
            }
        }
        this._diffHunksCache.set(key, value);
    }

    /**
     * Computes zero-context unified diff hunks (`git diff -U0`) between two commits
     * for the requested repo-relative file paths. Returns `undefined` if either commit
     * does not exist in the local git object store.
     */
    async getCommitDiffHunks(
        fromCommitId: string,
        toCommitId: string,
        filePaths: readonly string[],
    ): Promise<Map<string, DiffHunkRange[]> | undefined> {
        const resultMap = new Map<string, DiffHunkRange[]>();
        if (filePaths.length === 0) {
            return resultMap;
        }
        if (fromCommitId === toCommitId) {
            for (const filePath of filePaths) {
                resultMap.set(filePath, []);
            }
            return resultMap;
        }

        const missingPaths: string[] = [];
        for (const filePath of filePaths) {
            const cacheKey = `commit:${fromCommitId}:${toCommitId}:${filePath}`;
            const cached = this._diffHunksCache.get(cacheKey);
            if (cached === null) {
                return undefined;
            }
            if (cached !== undefined) {
                resultMap.set(filePath, cached);
            } else {
                missingPaths.push(filePath);
            }
        }

        if (missingPaths.length === 0) {
            return resultMap;
        }

        try {
            const filesets = missingPaths.map((p) =>
                formatRootFileFileset(normalizeRepoSeparators(p, this._pathPlatform)),
            );
            const stdout = await this.run(
                'diff',
                ['--git', '--context=0', '--from', fromCommitId, '--to', toCommitId, '--', ...filesets],
                { useCachedSnapshot: true, label: 'getCommitDiffHunks' },
            );

            const parsedByFile = parseMultiFileDiffHunks(stdout, this._pathPlatform);
            for (const filePath of missingPaths) {
                const hunks = parsedByFile.get(filePath) ?? [];
                this._setDiffHunksCache(`commit:${fromCommitId}:${toCommitId}:${filePath}`, hunks);
                resultMap.set(filePath, hunks);
            }
            return resultMap;
        } catch {
            for (const filePath of missingPaths) {
                this._setDiffHunksCache(`commit:${fromCommitId}:${toCommitId}:${filePath}`, null);
            }
            return undefined;
        }
    }

    /**
     * Computes zero-context unified diff hunks (`git diff -U0`) between two git blob
     * SHAs or `<rev>:<path>` specs. Returns `undefined` if either object is missing
     * from the local git store.
     */
    async getBlobDiffHunks(fromSpec: string, toSpec: string): Promise<DiffHunkRange[] | undefined> {
        if (fromSpec === toSpec) {
            return [];
        }
        const cacheKey = `blob:${fromSpec}:${toSpec}`;
        const cached = this._diffHunksCache.get(cacheKey);
        if (cached !== undefined) {
            return cached ?? undefined;
        }

        try {
            const gitRoot = await this.getGitRoot();
            const res = await this.system.process.execFile(
                'git',
                [
                    '--no-pager',
                    '--no-optional-locks',
                    ...(gitRoot ? [`--git-dir=${gitRoot}`] : []),
                    'diff',
                    '-U0',
                    '--no-ext-diff',
                    '--no-color',
                    fromSpec,
                    toSpec,
                ],
                {
                    cwd: this.workspaceRoot,
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: 10000,
                },
            );

            const hunks = parseDiffHunks(res.stdout);
            this._setDiffHunksCache(cacheKey, hunks);
            return hunks;
        } catch {
            this._setDiffHunksCache(cacheKey, null);
            return undefined;
        }
    }

    async getGitBlobContent(blobSha: string): Promise<string | undefined> {
        if (!blobSha || blobSha === 'none' || /^0{4,64}$/.test(blobSha)) {
            return '';
        }

        if (!/^[0-9a-fA-F]{4,64}$/.test(blobSha)) {
            this.logger.debug(`getGitBlobContent rejected invalid blobSha: ${blobSha}`);
            return undefined;
        }

        const cached = this._gitBlobContentCache.get(blobSha);
        if (cached !== undefined) {
            return cached;
        }

        try {
            const gitRoot = await this.getGitRoot();
            const timeout = 10000;
            const res = await this.system.process.execFile(
                'git',
                [
                    '--no-pager',
                    '--no-optional-locks',
                    ...(gitRoot ? [`--git-dir=${gitRoot}`] : []),
                    'cat-file',
                    '-p',
                    blobSha,
                ],
                {
                    cwd: this.workspaceRoot,
                    maxBuffer: 10 * 1024 * 1024,
                    timeout,
                },
            );

            this._gitBlobContentCache.set(blobSha, res.stdout);
            return res.stdout;
        } catch (err) {
            this.logger.debug(`getGitBlobContent failed for ${blobSha}: ${getErrorMessage(err)}`);
            return undefined;
        }
    }

    /**
     * Reads commit message and first-parent file changes for a git commit present in the local `.git` store.
     */
    async getGitCommitDetails(commitId: string): Promise<GitCommitDetails | undefined> {
        if (!HEX_COMMIT_PATTERN.test(commitId)) {
            return undefined;
        }

        const cached = this._gitCommitDetailsCache.get(commitId);
        if (cached !== undefined) {
            return cached;
        }

        const gitRoot = await this.getGitRoot();
        if (!gitRoot) {
            return undefined;
        }

        try {
            const res = await this.system.process.execFile(
                'git',
                [
                    '--no-pager',
                    '--no-optional-locks',
                    `--git-dir=${gitRoot}`,
                    'diff-tree',
                    '--always',
                    '--no-abbrev',
                    '-r',
                    '-z',
                    '-M',
                    '--first-parent',
                    '--root',
                    '--format=%B',
                    commitId,
                ],
                {
                    cwd: this.workspaceRoot,
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: 10000,
                },
            );

            const tokens = res.stdout.split('\0');
            const description = (tokens[0] ?? '').replace(/\r?\n$/, '');
            const files = parseGitRawFiles(tokens, 1, this._pathPlatform);
            const details: GitCommitDetails = { description, files };
            this._gitCommitDetailsCache.set(commitId, details);
            return details;
        } catch (err) {
            this.logger.debug(`getGitCommitDetails failed for ${commitId}: ${getErrorMessage(err)}`);
            return undefined;
        }
    }

    /**
     * Computes PR/MR range file changes (`baseCommitId...headCommitId`) from the local `.git` store.
     */
    async getGitRangeFiles(
        baseCommitId: string,
        headCommitId: string,
    ): Promise<Record<string, UploadedRevisionFile> | undefined> {
        if (!HEX_COMMIT_PATTERN.test(baseCommitId) || !HEX_COMMIT_PATTERN.test(headCommitId)) {
            return undefined;
        }

        const cacheKey = `${baseCommitId}...${headCommitId}`;
        const cached = this._gitRangeFilesCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        const gitRoot = await this.getGitRoot();
        if (!gitRoot) {
            return undefined;
        }

        try {
            const res = await this.system.process.execFile(
                'git',
                [
                    '--no-pager',
                    '--no-optional-locks',
                    `--git-dir=${gitRoot}`,
                    'diff',
                    '--raw',
                    '--no-abbrev',
                    '-z',
                    '--no-ext-diff',
                    '--no-color',
                    '-M',
                    `${baseCommitId}...${headCommitId}`,
                ],
                {
                    cwd: this.workspaceRoot,
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: 10000,
                },
            );

            const files = parseGitRawFiles(res.stdout.split('\0'), 0, this._pathPlatform);
            this._gitRangeFilesCache.set(cacheKey, files);
            return files;
        } catch (err) {
            this.logger.debug(`getGitRangeFiles failed for ${cacheKey}: ${getErrorMessage(err)}`);
            return undefined;
        }
    }
}
