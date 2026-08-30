/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as cp from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { z } from 'zod';
import { AsyncCache } from '../utils/async-cache';
import { getErrorMessage } from '../utils/error-utils';
import { type LoggerChannel, NO_OP_LOGGER } from '../utils/output-channel';
import type { IJjTrackedProcess, JjProcessTracker } from './jj-process-tracker';
import {
    ChangesAndStatsOutputSchema,
    type DiffStatEntry,
    JjBookmarkSchema,
    type JjFileChange,
    JjFileChangeSchema,
    type JjFileChangeWithStats,
    JjLogEntrySchema,
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

export { NO_OP_LOGGER };

export interface JjLogOptions {
    revision?: string;
    limit?: number;
    omitChanges?: boolean;
    includeNearestVisibleAncestors?: boolean;
}

// Safety timeout: if a mutation takes longer than this, unblock file watcher
const ONE_MINUTE = 60_000;
const MUTATION_TIMEOUT_MS = ONE_MINUTE;
const READ_TIMEOUT_MS = 2 * ONE_MINUTE;
const UPLOAD_TIMEOUT_MS = 6 * ONE_MINUTE;

const IS_WINDOWS = process.platform === 'win32';
const NO_OP_EDITOR = IS_WINDOWS ? 'cmd.exe /c exit 0' : 'true';

export type JjServiceConfigProvider<S = never> = <T>(key: string, defaultValue?: T, scope?: S) => T | undefined;

export interface JjServiceOptions {
    binaryPath?: string;
    getConfig?: JjServiceConfigProvider;
    processTracker?: JjProcessTracker;
}

export class JjService {
    public binaryPath: string;
    public processTracker?: JjProcessTracker;
    private readonly _getConfig?: JjServiceConfigProvider;
    private _writeOperationCount = 0;
    private _lastWriteTime = 0;
    private _operationTimeouts = new Map<number, NodeJS.Timeout>();
    private _nextOpId = 0;
    private _diffCache = new AsyncCache<string, { tempDir: string; expires: number }>({
        onEvict: (entry) => fs.rm(entry.tempDir, { recursive: true, force: true }).catch(() => {}),
    });
    private _changesCache = new AsyncCache<string, JjStatusEntry[]>({
        clone: (entries) => entries.map((e) => ({ ...e })),
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
    async getRepoRoot(): Promise<string> {
        if (this._repoRoot) {
            return this._repoRoot;
        }
        this._repoRoot = await this.run('root', [], { useCachedSnapshot: true, label: 'getRepoRoot' });
        return this._repoRoot;
    }

    /**
     * Resolves the path to the repository's store (usually .jj/repo).
     * Handles both default workspaces (where it's a directory) and secondary
     * workspaces (where it's a file pointing to the main repo's store).
     */
    async getRepoStorePath(): Promise<string> {
        const workspaceRoot = await this.getRepoRoot();
        const repoPath = path.join(workspaceRoot, '.jj', 'repo');
        try {
            const stats = await fs.lstat(repoPath);
            if (stats.isFile()) {
                const content = await fs.readFile(repoPath, 'utf8');
                return path.resolve(path.dirname(repoPath), content.trim());
            }
            return await fs.realpath(repoPath);
        } catch {
            return repoPath;
        }
    }

    /**
     * Finds the root directory of the "main" workspace (the one containing the repo store).
     */
    async getMainWorkspaceRoot(): Promise<string> {
        const storePath = await this.getRepoStorePath();
        // The store is typically <main-root>/.jj/repo.
        // Parent 1: <main-root>/.jj
        // Parent 2: <main-root>
        return path.dirname(path.dirname(storePath));
    }

    async getGitRoot(): Promise<string | null> {
        try {
            return await this.run('git', ['root'], { useCachedSnapshot: true, label: 'getGitRoot' });
        } catch {
            return null;
        }
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

    private toRelative(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return path.relative(this.workspaceRoot, filePath);
        }
        return filePath;
    }

    private async toRepoRelative(filePath: string): Promise<string> {
        const repoRoot = await this.getRepoRoot();
        const repoReal = await fs.realpath(repoRoot).catch(() => repoRoot);
        const workspaceReal = await fs.realpath(this.workspaceRoot).catch(() => this.workspaceRoot);

        if (!path.isAbsolute(filePath)) {
            const repoToWorkspace = path.relative(repoReal, workspaceReal);
            return path.normalize(path.join(repoToWorkspace, filePath));
        }

        const rel = path.relative(repoReal, filePath);
        if (!rel.startsWith('..')) {
            return path.normalize(rel);
        }

        const fileReal = await this.resolveRealPath(filePath);
        return path.normalize(path.relative(repoReal, fileReal));
    }

    private async resolveRealPath(filePath: string): Promise<string> {
        try {
            return await fs.realpath(filePath);
        } catch {}

        let cur = path.dirname(filePath);
        const tail: string[] = [path.basename(filePath)];
        while (cur && cur !== path.dirname(cur)) {
            try {
                const parentReal = await fs.realpath(cur);
                return path.join(parentReal, ...tail);
            } catch {
                tail.unshift(path.basename(cur));
                cur = path.dirname(cur);
            }
        }
        return filePath;
    }

    private getScriptPath(scriptBaseName: string): string {
        const isWin = process.platform === 'win32';
        const scriptName = isWin ? `${scriptBaseName}.bat` : `${scriptBaseName}.sh`;
        const candidate1 = path.join(__dirname, '..', 'scripts', scriptName);
        if (fsSync.existsSync(candidate1)) {
            return candidate1;
        }
        return path.join(__dirname, '..', '..', 'scripts', scriptName);
    }

    private getToolConfigArgs(toolName: string, scriptPath: string, argsTemplate: string[]): string[] {
        const isWin = process.platform === 'win32';
        const normalizedScriptPath = scriptPath.split(path.sep).join('/');

        // Ensure all arguments in the template are quoted for the JSON array
        const quotedArgs = argsTemplate.map((arg) => {
            if (arg.startsWith('"') && arg.endsWith('"')) {
                return arg;
            }
            return `"${arg}"`;
        });

        if (isWin) {
            // On Windows, we must use cmd /c to execute .bat files correctly from jj
            const escapedScriptPath = normalizedScriptPath.replace(/\//g, '\\\\');
            return [
                `--config=merge-tools.${toolName}.program="cmd"`,
                `--config=merge-tools.${toolName}.merge-args=["/c", "${escapedScriptPath}", ${quotedArgs.join(', ')}]`,
                `--config=merge-tools.${toolName}.edit-args=["/c", "${escapedScriptPath}", ${quotedArgs.join(', ')}]`,
            ];
        } else {
            return [
                `--config=merge-tools.${toolName}.program="${normalizedScriptPath}"`,
                `--config=merge-tools.${toolName}.merge-args=[${quotedArgs.join(', ')}]`,
                `--config=merge-tools.${toolName}.edit-args=[${quotedArgs.join(', ')}]`,
            ];
        }
    }

    // POLICY: This method is intentionally private. Do not expose it publicly.
    // Instead, create specific methods for each operation to ensure strictly typed usage
    // and prevent arbitrary command execution.
    private async run(
        command: string,
        args: string[],
        options: cp.ExecFileOptions & {
            trim?: boolean;
            useCachedSnapshot?: boolean;
            isMutation?: boolean;
            label?: string;
        } = {},
    ): Promise<string> {
        if (options.isMutation) {
            return this.runMutation(() => this.runInternal(command, args, options));
        }
        return this.runInternal(command, args, options);
    }

    private async runInternal(
        command: string,
        args: string[],
        options: cp.ExecFileOptions & {
            trim?: boolean;
            useCachedSnapshot?: boolean;
            isMutation?: boolean;
            label?: string;
        } = {},
    ): Promise<string> {
        const opId = this._nextOpId++;

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

        const start = performance.now();
        const allArgs = [...globalArgs, command, ...args];
        const prefix = options.label ? `[${options.label}] ` : '';
        const fullCommandStr = `jj ${[command, ...args].join(' ')}`;
        const logSummaryStr = `${prefix}jj ${[command, ...args].slice(0, 2).join(' ')}${[command, ...args].length > 2 ? '...' : ''}`;

        const isMutation = !!options.isMutation;
        let timeout: NodeJS.Timeout | undefined;
        let timedOut = false;

        try {
            const { stdout } = await new Promise<{ stdout: string | Buffer }>((resolve, reject) => {
                const maxDuration = options.timeout ?? (isMutation ? MUTATION_TIMEOUT_MS : this.getReadTimeoutMs());
                let childProcess: cp.ChildProcess | undefined;
                let trackedProcess: IJjTrackedProcess | undefined;

                timeout = setTimeout(() => {
                    timedOut = true;
                    const opType = isMutation ? 'Mutation operation' : 'Read operation';
                    const timeoutMsg = `${opType} timed out after ${maxDuration / 1000}s`;
                    this.logger.warn(`[${timeoutMsg}] ${logSummaryStr}`);
                    trackedProcess?.finish('timed_out', timeoutMsg);
                    if (childProcess) {
                        try {
                            childProcess.kill();
                        } catch {}
                    }
                    reject(new Error(timeoutMsg));
                }, maxDuration);

                if (isMutation) {
                    this._operationTimeouts.set(opId, timeout);
                }

                const finalOptions = {
                    cwd: this.workspaceRoot,
                    env: {
                        ...process.env,
                        JJ_EDITOR: NO_OP_EDITOR,
                        EDITOR: NO_OP_EDITOR,
                        JJ_VIEW_EXTENSION: '1',
                    },
                    maxBuffer: 100 * 1024 * 1024,
                    ...options,
                };

                childProcess = cp.execFile(this.binaryPath, allArgs, finalOptions, (err, stdout, stderr) => {
                    if (timedOut) {
                        return;
                    }
                    const duration = performance.now() - start;
                    const cachedInfo = options.useCachedSnapshot ? ' (cached)' : '';
                    this.logger.debug(`[${duration.toFixed(0)}ms]${cachedInfo} ${logSummaryStr}`);

                    if (err) {
                        const combined: string[] = [];
                        const outStr = stdout?.toString().trim();
                        const errStr = stderr?.toString().trim();
                        if (outStr) {
                            combined.push(outStr);
                        }
                        if (errStr) {
                            combined.push(errStr);
                        }
                        if (combined.length > 0) {
                            err.message = combined.join('\n\n');
                        }
                        trackedProcess?.finish('failed', err, stdout, stderr);
                        reject(err);
                    } else {
                        trackedProcess?.finish('completed', undefined, stdout, stderr);
                        resolve({ stdout });
                    }
                });

                // Note: startTrackingProcess is called synchronously right after execFile returns childProcess.
                // Because Node.js executes synchronously within the current tick of the event loop, the completion
                // callback passed to execFile will fire asynchronously on a later tick, guaranteeing that trackedProcess
                // is assigned before trackedProcess?.finish() can be called inside the callback.
                trackedProcess = this.processTracker?.startTrackingProcess({
                    command: fullCommandStr,
                    args: allArgs,
                    status: 'running',
                    label: options.label,
                    childProcess,
                });
            });

            if (isMutation) {
                await this.clearCache().catch((err) => this.logger.warn(`Warning: failed to clear cache: ${err}`));
            }

            const shouldTrim = options.trim !== false;
            const result = typeof stdout === 'string' ? stdout : stdout.toString();
            return shouldTrim ? result.trim() : result;
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

    async getLog(options: JjLogOptions = {}): Promise<JjLogEntry[]> {
        const { revision, limit, omitChanges, includeNearestVisibleAncestors } = options;

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

        const output = await this.run('log', args, { useCachedSnapshot: true, label: 'getLog' });
        const entries = this._parseJsonLines(output, JjLogEntrySchema, 'getLog');

        if (includeNearestVisibleAncestors) {
            const visibleIds = new Set<string>(entries.map((e) => e.change_id));
            await this._resolveNearestVisibleAncestors(entries, visibleIds, revision);
        }

        return entries;
    }

    private async _resolveNearestVisibleAncestors(
        entries: JjLogEntry[],
        visibleIds: Set<string>,
        revision?: string,
    ): Promise<void> {
        // Determine the search set for nearest ancestors.
        // If an explicit revision was provided, we use that.
        // Otherwise, we default to the configured log revset (or a safe fallback).
        let searchSet = revision;
        if (!searchSet) {
            try {
                searchSet = await this.run('config', ['get', 'revsets.log'], {
                    useCachedSnapshot: true,
                    label: 'getLog:revsets.log',
                });
            } catch {
                searchSet = 'present(@) | ancestors(immutable_heads().., 2) | trunk()';
            }
        }

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

    async restore(paths: string[], options: { from?: string; into?: string; changesIn?: string } = {}): Promise<void> {
        if (paths.length === 0) {
            return;
        }
        const relativePaths = paths.map((p) => this.toRelative(p));
        const cmdArgs = [...relativePaths];
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
        await this.run('restore', cmdArgs, { isMutation: true, label: 'restore' });
    }

    /**
     * Get the base, left (ours), and right (theirs) content for a conflicted file.
     * Uses `jj resolve` with a custom capture tool to extract the properly separated content.
     */
    async getConflictParts(filePath: string): Promise<{ base: string; left: string; right: string }> {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-conflict-'));
        const relativePath = this.toRelative(filePath);

        try {
            // Normalize path separators to forward slashes for safe injection into JS script string
            const tempDirNormalized = tempDir.split(path.sep).join('/');
            const basePath = `${tempDirNormalized}/base`;
            const leftPath = `${tempDirNormalized}/left`;
            const rightPath = `${tempDirNormalized}/right`;

            const normalizedScriptPath = this.getScriptPath('conflict-capture');

            try {
                const toolName = 'vscode-capture';
                const toolConfig = this.getToolConfigArgs(toolName, normalizedScriptPath, [
                    '$base',
                    '$left',
                    '$right',
                    tempDirNormalized,
                ]);

                await this.run('resolve', ['--tool', toolName, ...toolConfig, relativePath], {
                    useCachedSnapshot: true,
                });
            } catch {
                // Expected: jj returns error because our tool exits with 1
            }

            const base = await fs.readFile(basePath, 'utf8');
            const left = await fs.readFile(leftPath, 'utf8');
            const right = await fs.readFile(rightPath, 'utf8');

            return { base, left, right };
        } finally {
            await fs.rm(tempDir, { recursive: true }).catch(() => {});
        }
    }

    /**
     * Get the left (auto-merged parents) and right (revision) content for a file's diff.
     * Uses the bulk cache, warming it if necessary.
     */
    async getDiffContent(revision: string, filePath: string): Promise<{ left: string; right: string }> {
        const cache = await this.getDiffForRevision(revision);
        const relativePath = await this.toRepoRelative(filePath);
        const leftPath = path.join(cache.tempDir, 'left', relativePath);
        const rightPath = path.join(cache.tempDir, 'right', relativePath);

        const leftExists = await fs
            .access(leftPath)
            .then(() => true)
            .catch(() => false);
        const rightExists = await fs
            .access(rightPath)
            .then(() => true)
            .catch(() => false);

        if (leftExists || rightExists) {
            const left = leftExists ? await fs.readFile(leftPath, 'utf8') : '';
            const right = rightExists ? await fs.readFile(rightPath, 'utf8') : '';
            return { left, right };
        }

        // If not in cache, it means there are no differences for this file
        // relative to the parent(s). Fallback to fetching file content directly.
        // This handles "Quick Diff" on unchanged files where we need the base content.
        try {
            this.logger.debug(`getDiffContent fallback ${filePath} ${revision}`);
            const content = await this.getFileContent(filePath, revision);
            return { left: content, right: content };
        } catch {
            // If file doesn't exist in revision, return empty
            return { left: '', right: '' };
        }
    }

    /**
     * Ensures that the diff cache for a revision is warm and valid.
     * Extracts all changed files into a temporary directory using a single 'jj diffedit' call.
     */
    async getDiffForRevision(revision: string, force: boolean = false): Promise<{ tempDir: string; expires: number }> {
        if (force) {
            await this._diffCache.delete(revision);
        }
        return this._diffCache.getOrFetch(revision, () => this._warmDiffCache(revision));
    }

    private async _warmDiffCache(revision: string): Promise<{ tempDir: string; expires: number }> {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-bulk-diff-'));
        const leftDir = path.join(tempDir, 'left');
        const rightDir = path.join(tempDir, 'right');

        try {
            await fs.mkdir(leftDir, { recursive: true });
            await fs.mkdir(rightDir, { recursive: true });

            const normalizedScriptPath = this.getScriptPath('batch-diff');
            const toolName = 'vscode-bulk-capture';
            const toolConfig = this.getToolConfigArgs(toolName, normalizedScriptPath, [
                '$left',
                '$right',
                leftDir.split(path.sep).join('/'),
                rightDir.split(path.sep).join('/'),
            ]);

            try {
                await this.run('diffedit', ['-r', revision, '--ignore-immutable', '--tool', toolName, ...toolConfig], {
                    useCachedSnapshot: true,
                    label: `getDiffForRevision ${revision}`,
                });
            } catch (err) {
                // Verify that batch-diff actually ran and wrote the .complete marker
                const marker = path.join(rightDir, '.complete');
                const isCompleted = await fs
                    .access(marker)
                    .then(() => true)
                    .catch(() => false);
                if (!isCompleted) {
                    throw err;
                }
            }

            return {
                tempDir,
                expires: Date.now() + 5 * 60_000,
            };
        } catch (err) {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
            throw err;
        }
    }

    async clearCache(): Promise<void> {
        await Promise.all([this._diffCache.clear(), this._changesCache.clear()]);
    }

    /**
     * Check if a revision is immutable.
     */
    async isImmutable(revision: string): Promise<boolean> {
        const stdout = await this.run('log', ['-r', revision, '-T', 'immutable', '--no-graph']);
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
            const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-batch-edit-'));
            try {
                const writePromises = Array.from(files.entries()).map(async ([filePath, content], idx) => {
                    const repoRelPath = await this.toRepoRelative(filePath);
                    const workspaceRelPath = this.toRelative(filePath);
                    const safeName = repoRelPath.replace(/[\\/]/g, '_');
                    const tmpPath = path.join(tempDir, `src_${idx}_${safeName}`);
                    await fs.writeFile(tmpPath, content, 'utf8');
                    return { repoRelPath, workspaceRelPath, tmpPath };
                });

                const fileList = await Promise.all(writePromises);

                const normalizedScriptPath = this.getScriptPath('batch-edit');
                const toolName = 'vscode-batch-write';

                const argsTemplate = ['$left', '$right'];
                for (const f of fileList) {
                    argsTemplate.push(f.tmpPath.split(path.sep).join('/'));
                    argsTemplate.push(f.repoRelPath.split(path.sep).join('/'));
                }
                const toolConfig = this.getToolConfigArgs(toolName, normalizedScriptPath, argsTemplate);

                await this.runInternal(
                    'diffedit',
                    ['-r', revision, '--tool', toolName, ...toolConfig, ...fileList.map((f) => f.workspaceRelPath)],
                    { isMutation: true, label: 'setFilesContent' },
                );
            } finally {
                await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
        const relativePaths = paths.map((p) => this.toRelative(p));

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
        if (relativePaths.length > 0) {
            args.push(...relativePaths);
        }
        await this.run('squash', args, { isMutation: true, label: 'squashRevision' });
    }

    async rebase(
        source: string,
        destination: string | string[],
        mode: 'source' | 'revision' = 'source',
    ): Promise<string> {
        const args: string[] = [];
        const destinations = Array.isArray(destination) ? destination : [destination];
        destinations.forEach((d) => {
            args.push('-d', d);
        });

        if (mode === 'source') {
            // Rebase set (source and descendants)
            args.push('-s', source);
        } else {
            // Rebase revision (cherry-pick like behavior)
            args.push('-r', source);
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

    async undo(): Promise<string> {
        return this.run('undo', [], { isMutation: true, label: 'undo' });
    }

    async redo(): Promise<string> {
        return this.run('redo', [], { isMutation: true, label: 'redo' });
    }

    async getGitRemotes(): Promise<{ name: string; url: string }[]> {
        try {
            const output = await this.run('git', ['remote', 'list'], { label: 'getGitRemotes' });
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

        // Use a template to ensure clean, machine-readable output.
        // Paths are passed as positional arguments (filesets).
        // Since paths is just an array of workspace-relative strings, they act as implicit fileset matches.
        // E.g., jj file list path/to/a path/to/b
        const args = ['list', '-T', 'path.display() ++ "\\n"', ...nonEmptyPaths];
        try {
            const output = await this.run('file', args, { useCachedSnapshot: true, label: 'checkTrackedPaths' });
            return output
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
        } catch {
            return nonEmptyPaths;
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
        // Check cache first (only for default conflict style for now)
        if (conflictStyle === 'default') {
            try {
                const cache = await this.getDiffForRevision(revision);
                const relativePath = await this.toRepoRelative(filePath);
                const rightPath = path.join(cache.tempDir, 'right', relativePath);
                return await fs.readFile(rightPath, 'utf8');
            } catch {
                // Fall through if not in cache (e.g. file not changed in this revision)
            }
        }

        const relativePath = this.toRelative(filePath);
        const args = ['show', relativePath, '-r', revision];
        if (conflictStyle === 'git') {
            args.push('--config=ui.conflict-marker-style=git');
        }
        return this.run('file', args, { trim: false, label: 'getFileContent' });
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
                .map((line) => line.split(/\s+/)[0]);
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

    async cat(path: string, revision: string = '@-'): Promise<string> {
        const relativePath = this.toRelative(path);
        return this.run('file', ['show', '-r', revision, relativePath], {
            trim: false,
            useCachedSnapshot: true,
            label: 'cat',
        });
    }

    async status(): Promise<string> {
        return this.run('status', [], { isMutation: true, useCachedSnapshot: false, label: 'status' });
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
        });

        const output = await this.run('log', ['-r', revision, '--no-graph', '-T', combinedTemplate], {
            useCachedSnapshot: true,
            label: 'getChanges',
        });
        const entries = this._parseJsonLines(output, ChangesAndStatsOutputSchema, 'getChanges');
        if (entries.length === 0) {
            return [];
        }

        if (entries.length > 1) {
            this.logger.warn(
                `Expected single commit for revision '${revision}' in getChanges, but got ${entries.length} entries.`,
            );
        }

        const { changes, stats } = entries[0];
        const statsMap = new Map<string, DiffStatEntry>(stats.map((s) => [s.path, s]));

        return changes.map((c) => {
            const stat = statsMap.get(c.path);
            return {
                ...c,
                additions: stat?.additions ?? 0,
                deletions: stat?.deletions ?? 0,
            };
        });
    }

    private async _doGetChangesBetween(fromRevision: string, toRevision: string): Promise<JjFileChange[]> {
        const diffTemplate = buildLogTemplate(buildDiffFileSchema('self'));

        const output = await this.run('diff', ['-T', diffTemplate, '--from', fromRevision, '--to', toRevision], {
            useCachedSnapshot: true,
            label: 'getChangesBetween',
        });

        return this._parseJsonLines(output, JjFileChangeSchema, 'getChangesBetween');
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
        const relativePath = this.toRelative(file);
        return this.run('diff', ['--git', '-r', revision, relativePath], { useCachedSnapshot: true });
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

    /**
     * Squash specific line ranges (selection) from a file to its parent revision.
     *
     * @param fileRelPath Path relative to the workspace root.
     * @param ranges 0-indexed line ranges in the 'revision' to move.
     * @param revision The revision to move changes from (default: @).
     */
    async squashSelectionIntoParent(
        fileRelPath: string,
        ranges: SelectionRange[],
        revision: string = '@',
    ): Promise<void> {
        const parentRev = `${revision}-`;
        const { left: baseContent } = await this.getDiffContent(revision, fileRelPath);
        const diffOutput = await this.getDiff(revision, fileRelPath);

        const wantedContent = PatchHelper.applySelectedLines(baseContent, diffOutput, ranges);

        await this.runPartialSquash(revision, parentRev, fileRelPath, wantedContent);
    }

    private async runPartialSquash(
        fromRev: string,
        intoRev: string,
        fileRelPath: string,
        wantedContent: string,
    ): Promise<void> {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-partial-squash-'));
        const tmpFile = path.join(tmpDir, 'wanted_content');
        await fs.writeFile(tmpFile, wantedContent, 'utf8');

        try {
            const toolName = 'partial-squash';
            const normalizedScriptPath = this.getScriptPath('batch-edit');
            const toolConfig = this.getToolConfigArgs(toolName, normalizedScriptPath, [
                '$left',
                '$right',
                tmpFile.split(path.sep).join('/'),
                fileRelPath.split(path.sep).join('/'),
            ]);

            // squash --from X --into Y --tool ...
            const args = ['--from', fromRev, '--into', intoRev, '--tool', toolName, ...toolConfig, fileRelPath];

            await this.run('squash', args, { isMutation: true });
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    }

    async absorb(options: { paths?: string[]; fromRevision?: string } = {}): Promise<string> {
        const { paths, fromRevision } = options;
        const args: string[] = [];

        if (fromRevision) {
            args.push('--from', fromRevision);
        }
        if (paths && paths.length > 0) {
            // Check if paths are relative or absolute, assume toRelative handles it
            const relativePaths = paths.map((p) => this.toRelative(p));
            args.push(...relativePaths);
        }

        return this.run('absorb', args, { isMutation: true, label: 'absorb' });
    }

    async getGitBlobHashes(commitId: string, filePaths: string[]): Promise<Map<string, string>> {
        if (filePaths.length === 0) {
            return new Map();
        }

        // We use raw git command because jj doesn't expose ls-tree
        return new Promise((resolve) => {
            const timeout = 10000; // 10s safety timeout
            cp.execFile(
                'git',
                ['--no-pager', '--no-optional-locks', 'ls-tree', commitId, '--', ...filePaths],
                {
                    cwd: this.workspaceRoot,
                    maxBuffer: 10 * 1024 * 1024,
                    timeout,
                    env: {
                        ...process.env,
                    },
                },
                (err, stdout) => {
                    if (err) {
                        // If git fails (e.g. not a git repo, or commit not found in git backing), return empty
                        // This is expected fallback behavior
                        this.logger.warn(`getGitBlobHashes failed: ${err.message}`);
                        resolve(new Map());
                        return;
                    }

                    const resultMap = new Map<string, string>();
                    // Output format: <mode> blob <sha> <tab><path>
                    // 100644 blob 3a8500ab7725f03cca3806ee9ebaf7b4b53c3ca6    vitest.config.js

                    const lines = stdout.toString().trim().split('\n');
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
                            // Remove quotes if present (git ls-tree quotes paths with spaces/unusual chars)
                            const cleanPath =
                                pathPart.startsWith('"') && pathPart.endsWith('"') ? JSON.parse(pathPart) : pathPart;

                            resultMap.set(cleanPath, sha);
                        }
                    }
                    resolve(resultMap);
                },
            );
        });
    }
}
