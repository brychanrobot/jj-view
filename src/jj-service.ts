/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { JjLogEntry, JjStatusEntry } from './jj-types';
import { PatchHelper, SelectionRange } from './patch-helper';
import { buildLogTemplate, LOG_ENTRY_SCHEMA } from './jj-template-builder';

export interface JjLogOptions {
    revision?: string;
    limit?: number;
}



// Safety timeout: if a mutation takes longer than this, unblock file watcher
const ONE_MINUTE = 60_000;
const MUTATION_TIMEOUT_MS = ONE_MINUTE;
const UPLOAD_TIMEOUT_MS = 6 * ONE_MINUTE;

export class JjService {
    private _writeOperationCount = 0;
    private _lastWriteTime = 0;
    private _operationTimeouts = new Map<number, NodeJS.Timeout>();
    private _nextOpId = 0;
    private _diffCache = new Map<string, { tempDir: string; expires: number }>();
    private _diffCachePromises = new Map<string, Promise<{ tempDir: string; expires: number }>>();
    private _mutationMutex: Promise<void> = Promise.resolve();

    constructor(
        public readonly workspaceRoot: string,
        public readonly logger: (message: string) => void = () => {},
    ) {}

    get hasActiveWriteOps(): boolean {
        return this._writeOperationCount > 0;
    }

    get writeOpCount(): number {
        return this._writeOperationCount;
    }

    get lastWriteTime(): number {
        return this._lastWriteTime;
    }

    private toRelative(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return path.relative(this.workspaceRoot, filePath);
        }
        return filePath;
    }

    // POLICY: This method is intentionally private. Do not expose it publicly.
    // Instead, create specific methods for each operation to ensure strictly typed usage
    // and prevent arbitrary command execution.
    private async run(
        command: string,
        args: string[],
        options: cp.ExecFileOptions & { trim?: boolean; useCachedSnapshot?: boolean; isMutation?: boolean; label?: string } = {},
    ): Promise<string> {
        if (options.isMutation) {
            return this.runMutation(() => this.runInternal(command, args, options));
        }
        return this.runInternal(command, args, options);
    }

    private async runInternal(
        command: string,
        args: string[],
        options: cp.ExecFileOptions & { trim?: boolean; useCachedSnapshot?: boolean; isMutation?: boolean; label?: string } = {},
    ): Promise<string> {
        const opId = this._nextOpId++;

        const finalArgs = [...args];
        if (options.useCachedSnapshot) {
            finalArgs.push('--ignore-working-copy');
        }
        
        const start = performance.now();
        const allArgs = [command, ...finalArgs];
        const displayArgs = allArgs.slice(0, 2);
        const prefix = options.label ? `[${options.label}] ` : '';
        const commandStr = `${prefix}jj ${displayArgs.join(' ')}${allArgs.length > 2 ? '...' : ''}`;
        
        const isMutation = !!options.isMutation;
        let timeout: NodeJS.Timeout | undefined;

        try {
            const { stdout } = await new Promise<{ stdout: string | Buffer }>((resolve, reject) => {
                if (isMutation) {
                    const duration = options.timeout ?? MUTATION_TIMEOUT_MS;
                    timeout = setTimeout(() => {
                        reject(new Error(`Mutation operation timed out after ${duration / 1000}s`));
                    }, duration);
                    this._operationTimeouts.set(opId, timeout);
                }

                const finalOptions = {
                    cwd: this.workspaceRoot,
                    env: { ...process.env, PAGER: 'cat', JJ_NO_PAGER: '1', JJ_EDITOR: 'cat', EDITOR: 'cat' },
                    maxBuffer: 100 * 1024 * 1024, 
                    ...options,
                };

                cp.execFile('jj', [command, ...finalArgs], finalOptions, (err, stdout, stderr) => {
                    const duration = performance.now() - start;
                    const cachedInfo = options.useCachedSnapshot ? ' (cached)' : '';
                    this.logger(`[${duration.toFixed(0)}ms]${cachedInfo} ${commandStr}`);
                    
                    if (err) {
                        const combined: string[] = [];
                        const outStr = stdout?.toString().trim();
                        const errStr = stderr?.toString().trim();
                        if (outStr) combined.push(outStr);
                        if (errStr) combined.push(errStr);
                        if (combined.length > 0) err.message = combined.join('\n\n');
                        reject(err);
                    } else {
                        resolve({ stdout });
                    }
                });
            });

            if (isMutation) {
                await this.clearCache().catch(err => 
                    this.logger(`Warning: failed to clear cache: ${err}`)
                );
            }

            const shouldTrim = options.trim !== false;
            const result = typeof stdout === 'string' ? stdout : stdout.toString();
            return shouldTrim ? result.trim() : result;

        } finally {
            if (isMutation) {
                if (timeout) {
                    clearTimeout(timeout);
                    this._operationTimeouts.delete(opId);
                }
            }
        }
    }

    async getBookmarks(): Promise<string[]> {
        const output = await this.run('bookmark', ['list', '--no-pager', '-T', 'name ++ "\n"', '--all-remotes'], { useCachedSnapshot: true, label: 'getBookmarks' });
        const lines = output.trim().split('\n').filter((line) => line.length > 0);
        return Array.from(new Set(lines));
    }

    async moveBookmark(name: string, toRevision: string): Promise<string> {
        return this.run('bookmark', ['set', name, '-r', toRevision, '--allow-backwards'], { isMutation: true, label: 'moveBookmark' });
    }

    async getLog(options: JjLogOptions = {}): Promise<JjLogEntry[]> {
        const { revision, limit } = options;
        const args = ['-T', buildLogTemplate(LOG_ENTRY_SCHEMA)];
        if (revision) {
            args.push('-r', revision);
        }
        if (limit) {
            args.push('-n', limit.toString());
        } else if (!revision) {
            // Safety: If no revision is specified (default view), limit to 200 entries
            // to prevent buffer overflows and UI performance issues on huge repos.
            args.push('-n', '200');
        }

        const output = await this.run('log', args, { useCachedSnapshot: true, label: 'getLog' });
        const entries: JjLogEntry[] = [];

        for (const line of output.trim().split('\n')) {
            if (!line) {
                continue;
            }
            const jsonStart = line.indexOf('{');
            if (jsonStart === -1) {
                continue;
            }
            const jsonPart = line.substring(jsonStart);
            try {
                const raw = JSON.parse(jsonPart);
                entries.push(raw as JjLogEntry);
            } catch (e) {
                console.error('Failed to parse log entry:', line, e);
            }
        }
        return entries;
    }

    async restore(paths: string[], from?: string): Promise<void> {
        if (paths.length === 0) {
            return;
        }
        const relativePaths = paths.map((p) => this.toRelative(p));
        const cmdArgs = [...relativePaths];
        if (from) {
            cmdArgs.push('--from', from);
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

            // Simple script to copy the 3 conflict parts to temp dir
            // Exits with 1 to prevent jj from marking conflict as resolved
            const script = `
                const fs = require('fs');
                const [base, left, right] = process.argv.slice(1);
                fs.copyFileSync(base, '${basePath}');
                fs.copyFileSync(left, '${leftPath}');
                fs.copyFileSync(right, '${rightPath}');
                process.exit(1);
            `
                .replace(/\n/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const escapedScript = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

            try {
                await this.run(
                    'resolve',
                    [
                        '--tool',
                        'vscode-capture',
                        `--config=merge-tools.vscode-capture.program="node"`,
                        `--config=merge-tools.vscode-capture.merge-args=["-e", "${escapedScript}", "$base", "$left", "$right", "$output"]`,
                        relativePath,
                    ],
                    { useCachedSnapshot: true },
                );
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
        const relativePath = this.toRelative(filePath);
        const leftPath = path.join(cache.tempDir, 'left', relativePath);
        const rightPath = path.join(cache.tempDir, 'right', relativePath);

        const leftExists = await fs.access(leftPath).then(() => true).catch(() => false);
        const rightExists = await fs.access(rightPath).then(() => true).catch(() => false);

        if (leftExists || rightExists) {
            const left = leftExists ? await fs.readFile(leftPath, 'utf8') : '';
            const right = rightExists ? await fs.readFile(rightPath, 'utf8') : '';
            return { left, right };
        }

        // If not in cache, it means there are no differences for this file
        // relative to the parent(s). Fallback to fetching file content directly.
        // This handles "Quick Diff" on unchanged files where we need the base content.
        try {
            this.logger(`getDiffContent fallback ${filePath} ${revision}`);
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
        // Check for an in-progress warming operation for this revision
        if (!force) {
            const inProgress = this._diffCachePromises.get(revision);
            if (inProgress) {
                return inProgress;
            }
        }

        const cached = this._diffCache.get(revision);
        if (cached && !force && Date.now() < cached.expires) {
            return cached;
        }

        // Expired or missing: warm the cache
        const warmingPromise = this._warmDiffCache(revision, cached);
        this._diffCachePromises.set(revision, warmingPromise);
        return warmingPromise;
    }

    private async _warmDiffCache(revision: string, oldEntry?: { tempDir: string; expires: number }): Promise<{ tempDir: string; expires: number }> {
        try {
            // Cleanup first if we're forcing or it expired
            if (oldEntry) {
                await this.cleanupDiffCache(revision);
            }

            const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-bulk-diff-'));
            const leftDir = path.join(tempDir, 'left');
            const rightDir = path.join(tempDir, 'right');

            try {
                await fs.mkdir(leftDir, { recursive: true });
                await fs.mkdir(rightDir, { recursive: true });

                const script = `
                    const fs = require('fs');
                    const path = require('path');
                    const [left, right] = process.argv.slice(1);
                    
                    function copyDir(src, dest) {
                        if (!fs.existsSync(src)) return;
                        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
                        const entries = fs.readdirSync(src, { withFileTypes: true });
                        for (let entry of entries) {
                            const s = path.join(src, entry.name);
                            const d = path.join(dest, entry.name);
                            if (entry.isDirectory()) copyDir(s, d);
                            else fs.copyFileSync(s, d);
                        }
                    }
                    copyDir(left, '${leftDir.split(path.sep).join('/')}');
                    copyDir(right, '${rightDir.split(path.sep).join('/')}');
                    process.exit(1);
                `.replace(/\n/g, '').replace(/\s+/g, ' ').trim();

                const escapedScript = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

                try {
                    await this.run(
                        'diffedit',
                        [
                            '-r', revision,
                            '--tool', 'vscode-bulk-capture',
                            `--config=merge-tools.vscode-bulk-capture.program="node"`,
                            `--config=merge-tools.vscode-bulk-capture.edit-args=["-e", "${escapedScript}", "$left", "$right"]`,
                        ],
                        { useCachedSnapshot: true, label: `getDiffForRevision ${revision}` },
                    );
                } catch {
                    // Expected exit 1
                }

                const entry = {
                    tempDir,
                    expires: Date.now() + 5 * 60_000,
                };
                this._diffCache.set(revision, entry);
                return entry;
            } catch (err) {
                await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
                throw err;
            }
        } finally {
            // Always remove the promise from the map when finished
            this._diffCachePromises.delete(revision);
        }
    }

    async clearCache(): Promise<void> {
        this._diffCachePromises.clear();
        const keys = Array.from(this._diffCache.keys());
        await Promise.all(keys.map((revision) => this.cleanupDiffCache(revision)));
    }

    private async cleanupDiffCache(revision: string) {
        const cached = this._diffCache.get(revision);
        if (cached) {
            this._diffCache.delete(revision);
            await fs.rm(cached.tempDir, { recursive: true, force: true }).catch(() => {});
        }
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
        return this.runMutation(async () => {
            const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-batch-edit-'));
            try {
                const fileList: { relPath: string; tmpPath: string }[] = [];
                for (const [filePath, content] of files.entries()) {
                    const relPath = this.toRelative(filePath);
                    const safeName = relPath.replace(/[\\/]/g, '_');
                    const tmpPath = path.join(tempDir, `src_${safeName}`);
                    await fs.writeFile(tmpPath, content, 'utf8');
                    fileList.push({ relPath, tmpPath });
                }

                const copyCommands = fileList.map(f => {
                    const normalizedRelPath = f.relPath.split(path.sep).join('/');
                    const normalizedTmpPath = f.tmpPath.split(path.sep).join('/');
                    return `
                        try {
                            const dest = path.join(right, '${normalizedRelPath}');
                            const destDir = path.dirname(dest);
                            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                            fs.copyFileSync('${normalizedTmpPath}', dest);
                        } catch(e) {}
                    `;
                }).join('\n');

                const script = `
                    const fs = require('fs');
                    const path = require('path');
                    const [left, right] = process.argv.slice(1);
                    ${copyCommands}
                    process.exit(0);
                `.replace(/\n/g, '').replace(/\s+/g, ' ').trim();

                const escapedScript = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

                await this.runInternal(
                    'diffedit',
                    [
                        '-r', revision,
                        '--tool', 'vscode-batch-write',
                        `--config=merge-tools.vscode-batch-write.program="node"`,
                        `--config=merge-tools.vscode-batch-write.edit-args=["-e", "${escapedScript}", "$left", "$right"]`,
                        ...fileList.map(f => f.relPath),
                    ],
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
     * Squash changes into parent.
     * @param paths - specific files to squash (empty = all)
     * @param revision - if provided, squash this revision into its parent (-r flag)
     * @param intoRevision - if provided with revision, squash FROM revision INTO this (--from/--into)
     * @param message - optional message to use for the squashed commit
     */
    async squash(
        paths: string[] = [],
        revision?: string,
        intoRevision?: string,
        message?: string,
        useDestinationMessage?: boolean,
    ): Promise<void> {
        const args: string[] = [];
        const relativePaths = paths.map((p) => this.toRelative(p));

        if (revision && intoRevision) {
            // Squash from one revision into another
            args.push('--from', revision, '--into', intoRevision);
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
        await this.run('squash', args, { isMutation: true, label: 'squash' });
    }

    async rebase(
        source: string,
        destination: string | string[],
        mode: 'source' | 'revision' = 'source',
    ): Promise<string> {
        const args: string[] = [];
        const destinations = Array.isArray(destination) ? destination : [destination];
        destinations.forEach((d) => args.push('-d', d));

        if (mode === 'source') {
            // Rebase set (source and descendants)
            args.push('-s', source);
        } else {
            // Rebase revision (cherry-pick like behavior)
            args.push('-r', source);
        }
        return this.run('rebase', args, { isMutation: true, label: 'rebase' });
    }

    async duplicate(revision: string): Promise<string> {
        return this.run('duplicate', [revision], { isMutation: true, label: 'duplicate' });
    }

    async abandon(revisions: string | string[]): Promise<string> {
        const revs = Array.isArray(revisions) ? revisions : [revisions];
        return this.run('abandon', revs, { isMutation: true, label: 'abandon' });
    }

    async undo(): Promise<string> {
        return this.run('undo', [], { isMutation: true, label: 'undo' });
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
            { useCachedSnapshot: true, label: 'getChildren' }
        );
        return output
            .trim()
            .split('\n')
            .filter((line) => line.length > 0);
    }

    async moveChanges(paths: string[], fromRevision: string, toRevision: string): Promise<void> {
        const relativePaths = paths.map((p) => this.toRelative(p));
        await this.run('squash', ['--from', fromRevision, '--into', toRevision, ...relativePaths], { label: 'moveChanges' });
    }

    async new(options: { message?: string; parents?: string[]; insertBefore?: string[] } = {}): Promise<string> {
        const { message, parents = [], insertBefore = [] } = options;
        const args: string[] = [];
        if (message) {
            args.push('-m', message);
        }
        for (const rev of insertBefore) {
            args.push('--insert-before', rev);
        }
        
        if (insertBefore.length > 0) {
            // When insertBefore is used, parents must be specified with --insert-after
            for (const rev of parents) {
                args.push('--insert-after', rev);
            }
        } else {
            // Standard usage: parents are positional arguments
            args.push(...parents);
        }

        await this.run('new', args, { isMutation: true, label: 'new' });
        const output = await this.run('log', ['-r', '@', '--no-graph', '-T', 'change_id'], {
            useCachedSnapshot: true,
            label: 'new:getChangeId'
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
                const relativePath = this.toRelative(filePath);
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
            const output = await this.run('resolve', ['--list'], { useCachedSnapshot: true, label: 'getConflictedFiles' });
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
        return this.run('log', ['-r', revision, '--no-graph', '-T', 'description'], { useCachedSnapshot: true, label: 'getDescription' });
    }

    async cat(path: string, revision: string = '@-'): Promise<string> {
        const relativePath = this.toRelative(path);
        return this.run('file', ['show', '-r', revision, relativePath], { trim: false, useCachedSnapshot: true, label: 'cat' });
    }

    async status(): Promise<string> {
        return this.run('status', [], { useCachedSnapshot: false, label: 'status' });
    }

    async getChanges(revision: string): Promise<JjStatusEntry[]> {
        const output = await this.run('diff', ['--git', '-r', revision], { useCachedSnapshot: true });
        const entries: JjStatusEntry[] = [];

        const lines = output.split('\n');
        let currentEntry: JjStatusEntry | null = null;
        let isHeader = true;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('diff --git')) {
                if (currentEntry) {
                    entries.push(currentEntry);
                }
                currentEntry = { path: '', status: 'modified', additions: 0, deletions: 0 };
                isHeader = true;
                const parts = line.split(' ');
                if (parts.length >= 4) {
                    const bPath = parts[parts.length - 1];
                    currentEntry.path = bPath.startsWith('b/') ? bPath.substring(2) : bPath;
                }
                continue;
            }

            if (!currentEntry) {
                continue;
            }

            if (isHeader) {
                if (line.startsWith('new file mode')) {
                    currentEntry.status = 'added';
                } else if (line.startsWith('deleted file mode')) {
                    currentEntry.status = 'deleted';
                } else if (line.startsWith('rename from ')) {
                    currentEntry.status = 'renamed';
                    currentEntry.oldPath = line.substring('rename from '.length).trim();
                } else if (line.startsWith('rename to')) {
                    currentEntry.path = line.substring('rename to '.length).trim();
                } else if (line.startsWith('+++ b/')) {
                    currentEntry.path = line.substring('+++ b/'.length).trim();
                    isHeader = false;
                } else if (line.startsWith('--- a/') && currentEntry.status === 'deleted') {
                    currentEntry.path = line.substring('--- a/'.length).trim();
                } else if (line.startsWith('@@')) {
                    isHeader = false;
                }
            }

            if (!isHeader) {
                if (line.startsWith('+') && !line.startsWith('+++')) {
                    currentEntry.additions = (currentEntry.additions || 0) + 1;
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                    currentEntry.deletions = (currentEntry.deletions || 0) + 1;
                }
            }
        }

        if (currentEntry) {
            entries.push(currentEntry);
        }

        entries.forEach((e) => {
            if (e.path.startsWith('"') && e.path.endsWith('"')) {
                try {
                    e.path = JSON.parse(e.path);
                } catch (err) {}
            }
        });

        return entries;
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

    async upload(commandArgs: string[], revision: string): Promise<string> {
        return this.run(commandArgs[0], [...commandArgs.slice(1), '-r', revision], {
            isMutation: true,
            timeout: UPLOAD_TIMEOUT_MS,
        });
    }

    public async movePartialToParent(fileRelPath: string, ranges: SelectionRange[]): Promise<void> {
        const baseContent = await this.getFileContent(fileRelPath, '@-').catch(() => '');
        const diffOutput = await this.getDiff('@', fileRelPath);

        const wantedContent = PatchHelper.applySelectedLines(baseContent, diffOutput, ranges);

        // Squash changes from Child (@) into Parent (@-), effectively moving them up.
        await this.runPartialMove('@', '@-', fileRelPath, wantedContent);
    }

    public async movePartialToChild(fileRelPath: string, ranges: SelectionRange[]): Promise<void> {
        let baseContent = await this.getFileContent(fileRelPath, '@--').catch(() => '');

        const diffOutput = await this.getDiff('@-', fileRelPath);

        // Wanted Content for Parent: Grandparent + Unselected Changes
        const wantedContent = PatchHelper.applySelectedLines(baseContent, diffOutput, ranges, { inverse: true });

        // Strategy:
        // 1. Create a temp commit on Parent (@-) with the "reverted" content.
        // 2. Squash temp commit into Parent (Parent loses the changes).
        // 3. Child (@) is automatically rebased, but effectively loses the changes too (since it matched Parent).
        // 4. Restore Child from its pre-squash snapshot to preserve the changes as local modifications.
        const timestamp = Date.now();
        const tmpBookmark = `jj-move-tmp-${timestamp}`;
        // Capture the exact commit ID of the child to restore from later
        const oldChildId = (await this.run('log', ['-r', '@', '--no-graph', '-T', 'commit_id'])).trim();

        await this.run('bookmark', ['create', tmpBookmark, '-r', '@'], { isMutation: true, label: 'movePartialToParent' });

        try {
            // Create temp commit on top of Parent
            await this.run('new', ['@-'], { isMutation: true });

            // Write wanted content
            const absPath = path.join(this.workspaceRoot, fileRelPath);
            await fs.writeFile(absPath, wantedContent, 'utf8');

            // Squash into Parent
            // Note: 'squash' without args squashes @ into @-.
            await this.run('squash', [], { isMutation: true });
        } finally {
            // Return to Child (which has been rebased)
            await this.run('edit', [tmpBookmark], { isMutation: true });
            // Restore Child to its previous state (content-wise)
            // This ensures that changes removed from Parent appear as local changes in Child.
            await this.run('restore', ['--from', oldChildId, fileRelPath], { isMutation: true });

            await this.run('bookmark', ['delete', tmpBookmark], { isMutation: true });
        }
    }

    private async runPartialMove(
        fromRev: string,
        intoRev: string,
        fileRelPath: string,
        wantedContent: string,
    ): Promise<void> {
        const tmpDir = await fs.mkdtemp(path.join(this.workspaceRoot, 'jj-partial-'));
        const tmpFile = path.join(tmpDir, 'wanted_content');
        await fs.writeFile(tmpFile, wantedContent, 'utf8');

        try {
            const toolName = 'partial-move';
            const isWindows = process.platform === 'win32';
            const program = isWindows ? 'cmd' : 'cp';

            // For 'squash', $right is a directory snapshot. We must target the specific file within it.
            const destPath = isWindows ? `$right\\${fileRelPath.replace(/\//g, '\\')}` : `$right/${fileRelPath}`;

            const editArgs = isWindows
                ? `["/c", "copy", "/Y", "${tmpFile.replace(/\\/g, '\\\\')}", "${destPath.replace(/\\/g, '\\\\')}"]`
                : `["${tmpFile}", "${destPath}"]`;

            // squash --from X --into Y --tool ...
            const args = [
                '--from',
                fromRev,
                '--into',
                intoRev,
                '--tool',
                toolName,
                '--config',
                `merge-tools.${toolName}.program="${program}"`,
                '--config',
                `merge-tools.${toolName}.edit-args=${editArgs}`,
                '--config',
                'ui.editor="true"',
                '--no-pager',
                fileRelPath,
            ];

            await this.run('squash', args.slice(1), { isMutation: true });
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    }
    async absorb(options: { paths?: string[]; fromRevision?: string } = {}): Promise<string> {
        const { paths, fromRevision } = options;
        const args: string[] = ['--no-pager'];

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
             cp.execFile('git', ['ls-tree', commitId, '--', ...filePaths], {
                cwd: this.workspaceRoot,
                maxBuffer: 10 * 1024 * 1024
            }, (err, stdout) => {
                if (err) {
                    // If git fails (e.g. not a git repo, or commit not found in git backing), return empty
                    // This is expected fallback behavior
                    resolve(new Map());
                    return;
                }

                const resultMap = new Map<string, string>();
                // Output format: <mode> blob <sha> <tab><path>
                // 100644 blob 3a8500ab7725f03cca3806ee9ebaf7b4b53c3ca6    vitest.config.js
                
                const lines = stdout.toString().trim().split('\n');
                for (const line of lines) {
                    if (!line) continue;
                    
                    // Split by whitespace, but handle path potentially containing spaces (though git ls-tree usually quotes)
                    // Git ls-tree output is fairly standard: mode type sha\tpath
                    const parts = line.split(/\s+/); 
                    if (parts.length >= 4 && parts[1] === 'blob') {
                        const sha = parts[2];
                        const pathPart = line.substring(line.indexOf('\t') + 1);
                        // Remove quotes if present (git ls-tree quotes paths with spaces/unusual chars)
                        const cleanPath = pathPart.startsWith('"') && pathPart.endsWith('"') 
                            ? JSON.parse(pathPart) 
                            : pathPart;
                            
                        resultMap.set(cleanPath, sha);
                    }
                }
                resolve(resultMap);
            });
        });
    }
}
