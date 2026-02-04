// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

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
    useCachedSnapshot?: boolean;
}

export class JjService {
    constructor(public readonly workspaceRoot: string) {}

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
        options: cp.ExecFileOptions & { trim?: boolean; useCachedSnapshot?: boolean } = {},
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const finalOptions = {
                cwd: this.workspaceRoot,
                env: { ...process.env, PAGER: 'cat', JJ_NO_PAGER: '1', JJ_EDITOR: 'cat', EDITOR: 'cat' },
                ...options,
            };
            const finalArgs = [...args];
            if (options.useCachedSnapshot) {
                finalArgs.push('--ignore-working-copy');
            }
            cp.execFile('jj', [command, ...finalArgs], finalOptions, (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                const shouldTrim = options.trim !== false;
                if (typeof stdout === 'string') {
                    resolve(shouldTrim ? stdout.trim() : stdout);
                } else {
                    resolve(shouldTrim ? stdout.toString().trim() : stdout.toString());
                }
            });
        });
    }

    async moveBookmark(name: string, toRevision: string): Promise<string> {
        return this.run('bookmark', ['set', name, '-r', toRevision, '--allow-backwards']);
    }

    async getLog(options: JjLogOptions = {}): Promise<JjLogEntry[]> {
        const { revision, limit, useCachedSnapshot } = options;
        const args = ['-T', buildLogTemplate(LOG_ENTRY_SCHEMA)];
        if (revision) {
            args.push('-r', revision);
        }
        if (limit) {
            args.push('-n', limit.toString());
        }

        const output = await this.run('log', args, { useCachedSnapshot });
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
        await this.run('restore', cmdArgs);
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
                await this.run('resolve', [
                    '--tool',
                    'vscode-capture',
                    `--config=merge-tools.vscode-capture.program="node"`,
                    `--config=merge-tools.vscode-capture.merge-args=["-e", "${escapedScript}", "$base", "$left", "$right", "$output"]`,
                    relativePath,
                ]);
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
        await this.run('squash', args);
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
        return this.run('rebase', args);
    }

    async duplicate(revision: string): Promise<string> {
        return this.run('duplicate', [revision]);
    }

    async abandon(revisions: string | string[]): Promise<string> {
        const revs = Array.isArray(revisions) ? revisions : [revisions];
        return this.run('abandon', revs);
    }

    async undo(): Promise<string> {
        return this.run('undo', []);
    }

    async getGitRemotes(): Promise<{ name: string; url: string }[]> {
        try {
            const output = await this.run('git', ['remote', 'list']);
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

    async getChildren(revision: string = '@', useCachedSnapshot?: boolean): Promise<string[]> {
        const output = await this.run(
            'log',
            ['-r', `children(${revision})`, '--no-graph', '-T', 'change_id ++ "\\n"'],
            { useCachedSnapshot },
        );
        return output
            .trim()
            .split('\n')
            .filter((line) => line.length > 0);
    }

    async moveChanges(paths: string[], fromRevision: string, toRevision: string): Promise<void> {
        const relativePaths = paths.map((p) => this.toRelative(p));
        await this.run('squash', ['--from', fromRevision, '--into', toRevision, ...relativePaths]);
    }

    async new(message?: string, parents?: string | string[], insertBefore?: string): Promise<string> {
        const args: string[] = [];
        if (message) {
            args.push('-m', message);
        }
        if (insertBefore) {
            args.push('--insert-before', insertBefore);
        } else if (parents) {
            if (Array.isArray(parents)) {
                args.push(...parents);
            } else {
                args.push(parents);
            }
        }
        await this.run('new', args);
        const output = await this.run('log', ['-r', '@', '--no-graph', '-T', 'change_id'], {
            useCachedSnapshot: true,
        });
        return output.trim();
    }

    async getFileContent(
        path: string,
        revision: string = '@',
        conflictStyle: 'git' | 'default' = 'default',
    ): Promise<string> {
        const relativePath = this.toRelative(path);
        const args = ['show', relativePath, '-r', revision];
        if (conflictStyle === 'git') {
            args.push('--config=ui.conflict-marker-style=git');
        }
        return this.run('file', args, { trim: false });
    }

    async resolve(revision: string): Promise<void> {
        await this.run('new', [revision]);
    }

    async getConflictedFiles(useCachedSnapshot?: boolean): Promise<string[]> {
        try {
            const output = await this.run('resolve', ['--list'], { useCachedSnapshot });
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
        await this.run('describe', cmdArgs);
    }

    async getDescription(revision: string): Promise<string> {
        return this.run('log', ['-r', revision, '--no-graph', '-T', 'description']);
    }

    async cat(path: string, revision: string = '@-'): Promise<string> {
        const relativePath = this.toRelative(path);
        return this.run('file', ['show', '-r', revision, relativePath], { trim: false });
    }

    async status(useCachedSnapshot?: boolean): Promise<string> {
        return this.run('status', [], { useCachedSnapshot });
    }

    async getChanges(revision: string, useCachedSnapshot?: boolean): Promise<JjStatusEntry[]> {
        const output = await this.run('diff', ['--git', '-r', revision], { useCachedSnapshot });
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

    async getWorkingCopyChanges(useCachedSnapshot?: boolean): Promise<JjStatusEntry[]> {
        return this.getChanges('@', useCachedSnapshot);
    }

    async edit(revision: string): Promise<string> {
        return this.run('edit', [revision]);
    }

    async showDetails(revision: string): Promise<string> {
        return this.run('show', ['-r', revision, '--stat', '--color', 'always']);
    }

    async getDiff(revision: string, file: string): Promise<string> {
        const relativePath = this.toRelative(file);
        return this.run('diff', ['--git', '-r', revision, relativePath]);
    }

    async upload(commandArgs: string[], revision: string): Promise<string> {
        return this.run(commandArgs[0], [...commandArgs.slice(1), '-r', revision]);
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

        await this.run('bookmark', ['create', tmpBookmark, '-r', '@']);

        try {
            // Create temp commit on top of Parent
            await this.run('new', ['@-']);

            // Write wanted content
            const absPath = path.join(this.workspaceRoot, fileRelPath);
            await fs.writeFile(absPath, wantedContent, 'utf8');

            // Squash into Parent
            // Note: 'squash' without args squashes @ into @-.
            await this.run('squash', []);
        } finally {
            // Return to Child (which has been rebased)
            await this.run('edit', [tmpBookmark]);
            // Restore Child to its previous state (content-wise)
            // This ensures that changes removed from Parent appear as local changes in Child.
            await this.run('restore', ['--from', oldChildId, fileRelPath]);

            await this.run('bookmark', ['delete', tmpBookmark]);
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

            await this.run('squash', args.slice(1));
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    }
}
