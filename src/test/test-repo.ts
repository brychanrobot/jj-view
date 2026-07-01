/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tempDirs = new Set<string>();
const testXdgConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-test-xdg-'));
tempDirs.add(testXdgConfigHome);
process.env.XDG_CONFIG_HOME = testXdgConfigHome;

function writeDefaultConfig(xdgDir: string) {
    const configDir = path.join(xdgDir, 'jj');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'config.toml'),
        `[user]
name = "Test User"
email = "test@example.com"

[signing]
backend = "none"

[ui]
merge-editor = "builtin"
`,
    );
}

writeDefaultConfig(testXdgConfigHome);

process.on('exit', () => {
    for (const dir of tempDirs) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
    }
});

export class TestRepo {
    public readonly path: string;

    constructor(tmpDir?: string) {
        const rawPath = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-test-'));
        if (tmpDir) {
            fs.mkdirSync(rawPath, { recursive: true });
        }
        this.path = fs.realpathSync.native ? fs.realpathSync.native(rawPath) : fs.realpathSync(rawPath);
        tempDirs.add(this.path);
    }

    // POLICY: This method is intentionally private. Do not expose it publicly.
    // Instead, create specific methods for each operation to ensure strictly typed usage
    // and prevent arbitrary command execution in tests.
    private exec(args: string[], options: { trim?: boolean; suppressStderr?: boolean } = {}) {
        const env = { ...process.env, JJ_CONFIG: '' };
        const jjBinary = 'jj';
        try {
            const output = cp.execFileSync(jjBinary, ['--quiet', ...args], {
                cwd: this.path,
                encoding: 'utf-8',
                env,
                stdio: options.suppressStderr ? ['ignore', 'pipe', 'ignore'] : undefined,
            });
            return options.trim !== false ? output.trim() : output;
        } catch (e: unknown) {
            const err = e as {
                stdout?: Buffer;
                stderr?: Buffer;
                code?: string;
                status?: number;
                path?: string;
                message?: string;
            };
            const stderr = err.stderr?.toString() || '';

            // Handle "Command not found" specifically
            if (err.code === 'ENOENT') {
                const pathEnv = process.env.PATH || 'undefined';
                throw new Error(
                    `Could not find '${jjBinary}' binary in PATH.\n` +
                        `Current PATH: ${pathEnv}\n` +
                        `Check if jj is installed and available in the environment.`,
                );
            }

            // If the working copy is stale, try again with --ignore-working-copy
            // if we haven't already tried it.
            if (stderr.toLowerCase().includes('working copy is stale') && !args.includes('--ignore-working-copy')) {
                try {
                    const output = cp.execFileSync(jjBinary, ['--quiet', '--ignore-working-copy', ...args], {
                        cwd: this.path,
                        encoding: 'utf-8',
                        env,
                        stdio: options.suppressStderr ? ['ignore', 'pipe', 'ignore'] : undefined,
                    });
                    return options.trim !== false ? output.trim() : output;
                } catch {
                    // Fall through to original error if retry also fails
                }
            }

            // Re-throw with stdout/stderr for easier debugging
            const stdout = err.stdout?.toString() || 'undefined';
            throw new Error(
                `Command failed: jj ${args.join(' ')}\n` +
                    `Status: ${err.status}\n` +
                    `Stdout: ${stdout}\n` +
                    `Stderr: ${stderr}\n` +
                    `Raw Error: ${err.message}`,
            );
        }
    }

    config(name: string, value: string, suppressStderr?: boolean) {
        this.exec(['config', 'set', '--repo', name, value], { suppressStderr });
    }

    configBatch(configs: Record<string, string>) {
        if (process.platform !== 'win32') {
            const commands: string[] = [];

            for (const [key, val] of Object.entries(configs)) {
                commands.push(`jj --quiet config set --repo ${key} "${val}"`);
            }

            if (commands.length > 0) {
                const cmd = commands.join(' && ');
                const env = { ...process.env, JJ_CONFIG: '' };
                cp.execSync(cmd, { cwd: this.path, env, stdio: 'ignore' });
            }
        } else {
            for (const [key, val] of Object.entries(configs)) {
                this.config(key, val, true);
            }
        }
    }

    metaedit(options: { updateAuthor?: boolean; revision?: string } = {}) {
        const args = ['metaedit'];
        if (options.updateAuthor) {
            args.push('--update-author');
        }
        if (options.revision) {
            args.push('-r', options.revision);
        }
        this.exec(args);
    }

    init() {
        const env = { ...process.env, JJ_CONFIG: '' };
        const jjBinary = 'jj';
        cp.execFileSync(jjBinary, ['--quiet', 'git', 'init'], {
            cwd: this.path,
            encoding: 'utf-8',
            env,
        });

        if (process.platform !== 'win32') {
            const commands = [
                `jj --quiet config set --repo user.name "Test User"`,
                `jj --quiet config set --repo user.email "test@example.com"`,
                `jj --quiet config set --repo signing.backend "none"`,
                `jj --quiet config set --repo ui.merge-editor "builtin"`,
            ];
            cp.execSync(commands.join(' && '), { cwd: this.path, env, stdio: 'ignore' });
        } else {
            cp.execFileSync(jjBinary, ['--quiet', 'config', 'set', '--repo', 'user.name', 'Test User'], {
                cwd: this.path,
                env,
                stdio: 'ignore',
            });
            cp.execFileSync(jjBinary, ['--quiet', 'config', 'set', '--repo', 'user.email', 'test@example.com'], {
                cwd: this.path,
                env,
                stdio: 'ignore',
            });
            cp.execFileSync(jjBinary, ['--quiet', 'config', 'set', '--repo', 'signing.backend', 'none'], {
                cwd: this.path,
                env,
                stdio: 'ignore',
            });
            cp.execFileSync(jjBinary, ['--quiet', 'config', 'set', '--repo', 'ui.merge-editor', 'builtin'], {
                cwd: this.path,
                env,
                stdio: 'ignore',
            });
        }

        cp.execFileSync(jjBinary, ['--quiet', 'metaedit', '--update-author'], {
            cwd: this.path,
            encoding: 'utf-8',
            env,
        });
    }

    new(parents?: string[], message?: string) {
        const args = ['new'];
        if (parents && parents.length > 0) {
            args.push(...parents);
        }
        if (message) {
            args.push('-m', message);
        }
        this.exec(args);
    }

    snapshot() {
        this.exec(['status']);
    }

    describe(message: string, revision?: string) {
        const args = ['describe', '-m', message];
        if (revision) {
            args.push('-r', revision);
        }
        this.exec(args);
    }

    getDescription(revision: string): string {
        return this.exec(['log', '-r', revision, '-T', 'description', '--no-graph']);
    }

    edit(revision: string) {
        this.exec(['edit', revision]);
    }

    getWorkingCopyId(): string {
        return this.exec(['log', '--ignore-working-copy', '-r', '@', '-T', 'change_id', '--no-graph']);
    }

    getDiffSummary(revision: string = '@'): string {
        return this.exec(['diff', '-r', revision, '--summary']);
    }

    getDiff(revision: string = '@', options: { git?: boolean } = {}): string {
        const args = ['diff', '-r', revision];
        if (options.git) {
            args.push('--git');
        }
        return this.exec(args);
    }

    untrack(path: string | string[]): void {
        const paths = Array.isArray(path) ? path : [path];
        this.exec(['file', 'untrack', ...paths]);
    }

    getFiles(revision: string = '@'): string[] {
        const output = this.exec(['file', 'list', '-r', revision]);
        return output
            .split('\n')
            .map((f) => f.trim())
            .filter((f) => f.length > 0);
    }

    bookmark(name: string, revision: string) {
        this.exec(['bookmark', 'create', name, '-r', revision]);
    }

    bookmarkMove(name: string, revision: string) {
        this.exec(['bookmark', 'set', name, '-r', revision]);
    }

    tag(name: string, revision: string) {
        this.exec(['tag', 'set', name, '-r', revision]);
    }

    abandon(revision: string) {
        this.exec(['abandon', revision]);
    }

    squash(revision?: string, destination?: string) {
        const args = ['squash'];
        if (revision) {
            args.push('-r', revision);
        }
        if (destination) {
            args.push('-d', destination);
        }
        this.exec(args);
    }

    rebase(options: { revision?: string; destination?: string; source?: string } = {}) {
        const args = ['rebase'];
        if (options.revision) {
            args.push('-r', options.revision);
        }
        if (options.source) {
            args.push('-s', options.source);
        }
        if (options.destination) {
            args.push('-d', options.destination);
        }
        this.exec(args);
    }

    writeFile(relativePath: string, content: string) {
        const fullPath = path.join(this.path, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
        this.snapshot();
    }

    async writeFiles(files: Record<string, string>): Promise<void> {
        await Promise.all(
            Object.entries(files).map(async ([file, content]) => {
                const fullPath = path.join(this.path, file);
                await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.promises.writeFile(fullPath, content);
            }),
        );
        this.snapshot();
    }

    moveFile(oldPath: string, newPath: string) {
        const fullOldPath = path.join(this.path, oldPath);
        const fullNewPath = path.join(this.path, newPath);
        fs.renameSync(fullOldPath, fullNewPath);
        this.snapshot();
    }

    deleteFile(relativePath: string) {
        fs.rmSync(path.join(this.path, relativePath));
        this.snapshot();
    }

    readFile(relativePath: string): string {
        return fs.readFileSync(path.join(this.path, relativePath), 'utf-8');
    }

    getFileContent(revision: string, relativePath: string): string {
        return this.exec(['file', 'show', '-r', revision, relativePath], { trim: false });
    }

    getChangeId(revision: string): string {
        return this.exec(['log', '--ignore-working-copy', '-r', revision, '-T', 'change_id', '--no-graph']);
    }

    getCommitId(revision: string): string {
        return this.exec(['log', '--ignore-working-copy', '-r', revision, '-T', 'commit_id', '--no-graph']);
    }

    diff(relativePath: string, revision?: string): string {
        const args = ['diff', '--git'];
        if (revision) {
            args.push('-r', revision);
        }
        args.push(relativePath);
        return this.exec(args);
    }
    getParents(revision: string): string[] {
        const output = this.exec([
            'log',
            '-r',
            revision,
            '-T',
            "parents.map(|p| p.change_id()).join(' ')",
            '--no-graph',
        ]);
        if (!output) {
            return [];
        }
        return output.split(' ');
    }

    getChildren(revision: string): string[] {
        const output = this.exec(['log', '-r', `children(${revision})`, '-T', 'change_id ++ "\\n"', '--no-graph']);
        if (!output) {
            return [];
        }
        return output.trim().split('\n').filter(Boolean);
    }

    track(relativePath: string) {
        this.exec(['file', 'track', relativePath]);
    }

    addRemote(name: string, url: string) {
        this.exec(['git', 'remote', 'add', name, url]);
    }

    getBookmarks(revision: string): string[] {
        const output = this.exec(['log', '-r', revision, '-T', "bookmarks.map(|b| b.name()).join(' ')", '--no-graph']);
        if (!output) {
            return [];
        }
        return output.split(' ');
    }

    listFiles(revision: string): string[] {
        const output = this.exec(['file', 'list', '-r', revision]);
        if (!output) {
            return [];
        }
        return output.split('\n');
    }

    log(): string {
        return this.exec(['log', '--ignore-working-copy']);
    }

    getLogOutput(template: string): string {
        return this.exec(['log', '--ignore-working-copy', '-T', template, '--color', 'never']);
    }

    getLog(revision: string, template: string): string {
        return this.exec([
            'log',
            '--ignore-working-copy',
            '-r',
            revision,
            '-T',
            template,
            '--no-graph',
            '--color',
            'never',
        ]);
    }

    isImmutable(revision: string): boolean {
        const output = this.exec([
            'log',
            '--ignore-working-copy',
            '-r',
            revision,
            '-T',
            'immutable',
            '--no-graph',
            '--color',
            'never',
        ]);
        return output.trim() === 'true';
    }

    workspaceAdd(name: string, revision?: string, workspacePath?: string): TestRepo {
        const resolvedPath = workspacePath || path.join(this.path, name);
        fs.mkdirSync(resolvedPath, { recursive: true });
        const args = ['workspace', 'add', resolvedPath];
        if (revision) {
            args.push('-r', revision);
        }
        if (workspacePath) {
            args.push('--name', name);
        }
        this.exec(args);
        return new TestRepo(resolvedPath);
    }

    gitImport() {
        this.exec(['git', 'import']);
    }

    gitPush(bookmarkName: string) {
        this.exec(['git', 'push', '--bookmark', bookmarkName]);
    }

    listWorkspaces(): string {
        return this.exec(['workspace', 'list']);
    }

    hasGitRef(ref: string): boolean {
        try {
            cp.execFileSync('git', ['show-ref', '--verify', ref], {
                cwd: this.path,
                stdio: 'ignore',
            });
            return true;
        } catch {
            return false;
        }
    }

    listGitRefs(prefix?: string): string[] {
        try {
            const output = cp.execFileSync('git', ['show-ref'], {
                cwd: this.path,
                encoding: 'utf-8',
            });
            const refs = output
                .split('\n')
                .map((line) => line.trim().split(/\s+/)[1])
                .filter(Boolean);
            if (prefix) {
                return refs.filter((ref) => ref.startsWith(prefix));
            }
            return refs;
        } catch {
            return [];
        }
    }

    getCurrentOperationId(): string {
        return this.exec(['op', 'log', '-T', 'id', '--limit', '1', '--no-graph']);
    }

    getOperationsSince(opId: string): { id: string; description: string }[] {
        const output = this.exec(['op', 'log', '--no-graph', '-T', 'id ++ " " ++ description ++ "\\n"']);
        const lines = output
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        const ops: { id: string; description: string }[] = [];
        for (const line of lines) {
            const spaceIdx = line.indexOf(' ');
            const id = spaceIdx !== -1 ? line.substring(0, spaceIdx) : line;
            const description = spaceIdx !== -1 ? line.substring(spaceIdx + 1) : '';
            if (id.startsWith(opId) || opId.startsWith(id)) {
                break;
            }
            ops.push({ id, description });
        }
        return ops;
    }
}

export interface CommitDefinition {
    label?: string;
    parents?: string[];
    description?: string;
    files?: Record<string, string>;
    bookmarks?: string[];
    tags?: string[];
    isCurrentWorkingCopy?: boolean;
}

export interface CommitId {
    changeId: string;
    commitId: string;
}

export async function buildGraph(repo: TestRepo, commits: CommitDefinition[]): Promise<Record<string, CommitId>> {
    const labelToId: Record<string, CommitId> = {};
    const metadataOps: { type: 'bookmark' | 'tag'; name: string; changeId: string }[] = [];

    // Helper to resolve parents
    const resolveParents = (parents?: string[]): string[] => {
        if (!parents || parents.length === 0) {
            return [];
        }
        return parents.map((p) => labelToId[p]?.changeId || p);
    };

    for (const commit of commits) {
        const parents = resolveParents(commit.parents);
        const description = commit.description !== undefined ? commit.description : commit.label;

        repo.new(parents, description);

        // Apply file changes
        if (commit.files) {
            await repo.writeFiles(commit.files);
        }

        // Capture ID
        const changeId = repo.getChangeId('@');
        const commitId = repo.getCommitId('@');
        if (commit.label) {
            labelToId[commit.label] = { changeId, commitId };
        }

        // Collect bookmarks for later application
        if (commit.bookmarks) {
            for (const bookmark of commit.bookmarks) {
                metadataOps.push({ type: 'bookmark', name: bookmark, changeId });
            }
        }

        // Collect tags for later application
        if (commit.tags) {
            for (const tag of commit.tags) {
                metadataOps.push({ type: 'tag', name: tag, changeId });
            }
        }
    }

    // Apply metadata (tags and bookmarks) to specific IDs.
    // This is done after the initial graph construction loop so that
    // metadata operations (which might make commits immutable) don't
    // affect the working copy commit (@) during construction.
    for (const op of metadataOps) {
        if (op.type === 'bookmark') {
            repo.bookmark(op.name, op.changeId);
        } else if (op.type === 'tag') {
            repo.tag(op.name, op.changeId);
        }
    }

    // Handle isCurrentWorkingCopy
    for (const commit of commits) {
        if (commit.isCurrentWorkingCopy && commit.label) {
            const entry = labelToId[commit.label];
            if (entry) {
                repo.edit(entry.changeId);
            }
        }
    }

    // Return map
    return labelToId;
}
